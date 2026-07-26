import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';

import type { BrowserWindow, IpcMainInvokeEvent, WebContents } from 'electron';
import { BrowserWindow as ElectronBrowserWindow, ipcMain } from 'electron';
import { z } from 'zod';

import type { IpcResult } from '../../shared/application/contracts.js';
import {
  VOICE_IPC_CHANNELS,
  VOICE_MODEL_ID,
  VOICE_MODEL_REVISION,
  VoiceModelStatusSchema,
  VoiceTranscriptionInputSchema,
  VoiceTranscriptionSchema,
  type VoiceModelStatus,
  type VoiceTranscription,
  type VoiceTranscriptionInput,
} from '../../shared/voice/contracts.js';
import { createNativeOutboundConfirmation } from '../outbound/native-confirmation.js';
import {
  OutboundActionGate,
  assertOutboundExecutionPermit,
  type OutboundActionDisclosure,
  type OutboundAuditSink,
  type OutboundExecutionPermit,
} from '../outbound/outbound-action-gate.js';
import { assertLiveMainFrame } from '../security/ipc-authority.js';

const MARKER_FILE = 'installed.json';

interface VoiceDialog {
  showMessageBox(
    parent: BrowserWindow,
    options: Electron.MessageBoxOptions,
  ): Promise<{ response: number }>;
}

interface VoicePipelineOutput {
  text?: unknown;
}

type VoicePipeline = (
  samples: Float32Array,
  options: Record<string, unknown>,
) => Promise<VoicePipelineOutput | VoicePipelineOutput[]>;

interface TransformersModule {
  env: {
    allowLocalModels: boolean;
    allowRemoteModels: boolean;
    cacheDir: string;
  };
  pipeline(
    task: 'automatic-speech-recognition',
    model: string,
    options: Record<string, unknown>,
  ): Promise<unknown>;
}

export class VoiceIpcService {
  readonly #registered: string[] = [];
  readonly #ownerIds = new WeakMap<WebContents, string>();
  readonly #outbound: OutboundActionGate;
  readonly #modelDirectory: string;
  #pipeline: Promise<VoicePipeline> | null = null;
  #installing = false;
  #disposed = false;

  public constructor(
    private readonly dialog: VoiceDialog,
    private readonly audit: OutboundAuditSink,
    userDataPath: string,
    outbound?: OutboundActionGate,
  ) {
    this.#outbound = outbound ?? new OutboundActionGate(audit);
    this.#modelDirectory = join(userDataPath, 'voice-models');
  }

  public registerIpcHandlers(): void {
    this.#handle(VOICE_IPC_CHANNELS.status, z.tuple([]), async () => await this.status());
    this.#handle(
      VOICE_IPC_CHANNELS.install,
      z.tuple([]),
      async (event) => await this.#install(event),
    );
    this.#handle(
      VOICE_IPC_CHANNELS.remove,
      z.tuple([]),
      async (event) => await this.#remove(event),
    );
    this.#handle(
      VOICE_IPC_CHANNELS.transcribe,
      z.tuple([VoiceTranscriptionInputSchema]),
      async (event, input) => await this.#transcribe(event, input),
    );
  }

  public async status(): Promise<VoiceModelStatus> {
    const installed = await this.#hasValidMarker();
    return VoiceModelStatusSchema.parse({
      state: this.#installing ? 'installing' : installed ? 'ready' : 'not-installed',
      modelId: VOICE_MODEL_ID,
      revision: VOICE_MODEL_REVISION,
      localOnly: true,
    });
  }

  public dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    for (const channel of this.#registered) ipcMain.removeHandler(channel);
    this.#registered.length = 0;
    this.#pipeline = null;
  }

  public async resetForPrivacy(): Promise<void> {
    this.#pipeline = null;
    await rm(this.#modelDirectory, { recursive: true, force: true });
  }

  async #install(event: IpcMainInvokeEvent): Promise<VoiceModelStatus> {
    const parent = this.#parent(event, 'install the voice model');
    if (this.#installing) throw new Error('The voice model is already being installed.');
    if (await this.#hasValidMarker()) return await this.status();
    const ownerId = this.#ownerId(event.sender);
    const disclosure = modelDownloadDisclosure();
    const plan = this.#outbound.prepare(ownerId, disclosure);
    const confirmation = createNativeOutboundConfirmation({
      assertCurrent: () => this.#assertCurrent(event, parent),
      show: async (options) => (await this.dialog.showMessageBox(parent, options)).response,
    });
    this.#installing = true;
    let installed = false;
    try {
      const result = await this.#outbound.confirmAndExecute({
        ownerId,
        planId: plan.id,
        confirmation,
        currentDisclosure: modelDownloadDisclosure,
        execute: async (permit) => await this.#downloadAndLoad(permit),
      });
      this.#assertCurrent(event, parent);
      installed = result.outcome === 'allowed';
    } finally {
      this.#installing = false;
    }
    if (!installed) return await this.status();
    return VoiceModelStatusSchema.parse({
      ...(await this.status()),
      state: 'ready',
    });
  }

  async #remove(event: IpcMainInvokeEvent): Promise<VoiceModelStatus> {
    const parent = this.#parent(event, 'remove the voice model');
    const decision = await this.dialog.showMessageBox(parent, {
      type: 'warning',
      title: 'Remove local voice model?',
      message: 'Voice commands will stop working until the model is installed again.',
      detail: 'This deletes only Artemis’s downloaded speech model. It does not delete projects.',
      buttons: ['Cancel', 'Remove model'],
      defaultId: 0,
      cancelId: 0,
      noLink: true,
    });
    this.#assertCurrent(event, parent);
    if (decision.response !== 1) return await this.status();
    this.#pipeline = null;
    this.audit.appendAudit('voice', 'remove-model', 'allowed', {
      modelId: VOICE_MODEL_ID,
      revision: VOICE_MODEL_REVISION,
      phase: 'authorized-before-deletion',
    });
    try {
      await rm(this.#modelDirectory, { recursive: true, force: true });
    } catch (error) {
      this.audit.appendAudit('voice', 'remove-model', 'failed', {
        modelId: VOICE_MODEL_ID,
        revision: VOICE_MODEL_REVISION,
        reason: 'local-model-deletion-failed',
      });
      throw error;
    }
    return await this.status();
  }

  async #transcribe(
    event: IpcMainInvokeEvent,
    input: VoiceTranscriptionInput,
  ): Promise<VoiceTranscription> {
    const parent = this.#parent(event, 'transcribe voice audio');
    if (!(await this.#hasValidMarker())) {
      throw new Error('Install the local voice model in Settings before using voice commands.');
    }
    const started = performance.now();
    const transcriber = await this.#loadLocalPipeline();
    this.#assertCurrent(event, parent);
    const raw = await transcriber(input.samples, {
      return_timestamps: false,
    });
    this.#assertCurrent(event, parent);
    const output = Array.isArray(raw) ? raw[0] : raw;
    const text = typeof output?.text === 'string' ? output.text.trim() : '';
    const result = VoiceTranscriptionSchema.parse({
      text,
      durationMs: Math.round(performance.now() - started),
    });
    this.audit.appendAudit('voice', 'transcribe-local-audio', 'allowed', {
      modelId: VOICE_MODEL_ID,
      sampleCount: input.samples.length,
      transcriptCharacterCount: result.text.length,
      audioPersisted: false,
      networkUsed: false,
    });
    return result;
  }

  async #downloadAndLoad(permit: OutboundExecutionPermit): Promise<void> {
    assertOutboundExecutionPermit(permit);
    await mkdir(this.#modelDirectory, { recursive: true, mode: 0o700 });
    const transformers = await loadTransformers();
    configureTransformers(transformers, this.#modelDirectory, true);
    try {
      this.#pipeline = createPipeline(transformers, false);
      await this.#pipeline;
      await writeFile(
        join(this.#modelDirectory, MARKER_FILE),
        `${JSON.stringify({ modelId: VOICE_MODEL_ID, revision: VOICE_MODEL_REVISION })}\n`,
        { encoding: 'utf8', mode: 0o600 },
      );
    } catch (error) {
      this.#pipeline = null;
      await rm(this.#modelDirectory, { recursive: true, force: true });
      throw error;
    } finally {
      configureTransformers(transformers, this.#modelDirectory, false);
    }
  }

  async #loadLocalPipeline(): Promise<VoicePipeline> {
    if (this.#pipeline !== null) return await this.#pipeline;
    const transformers = await loadTransformers();
    configureTransformers(transformers, this.#modelDirectory, false);
    this.#pipeline = createPipeline(transformers, true);
    try {
      return await this.#pipeline;
    } catch (error) {
      this.#pipeline = null;
      throw new Error('The local voice model could not be loaded. Reinstall it in Settings.', {
        cause: error,
      });
    }
  }

  async #hasValidMarker(): Promise<boolean> {
    try {
      const marker = JSON.parse(
        await readFile(join(this.#modelDirectory, MARKER_FILE), 'utf8'),
      ) as {
        modelId?: unknown;
        revision?: unknown;
      };
      return marker.modelId === VOICE_MODEL_ID && marker.revision === VOICE_MODEL_REVISION;
    } catch {
      return false;
    }
  }

  #ownerId(owner: WebContents): string {
    const current = this.#ownerIds.get(owner);
    if (current !== undefined) return current;
    const ownerId = `voice:${String(owner.id)}`;
    this.#ownerIds.set(owner, ownerId);
    owner.once('destroyed', () => this.#outbound.discardOwner(ownerId));
    return ownerId;
  }

  #parent(event: IpcMainInvokeEvent, action: string): BrowserWindow {
    assertLiveMainFrame(event, `Voice: ${action}`);
    const parent = ElectronBrowserWindow.fromWebContents(event.sender);
    if (parent === null || parent.isDestroyed()) {
      throw new Error(`A live Artemis window is required to ${action}.`);
    }
    return parent;
  }

  #assertCurrent(event: IpcMainInvokeEvent, parent: BrowserWindow): void {
    if (this.#disposed) throw new Error('The voice service has been disposed.');
    assertLiveMainFrame(event, 'Voice operation');
    if (parent.isDestroyed() || ElectronBrowserWindow.fromWebContents(event.sender) !== parent) {
      throw new Error('The originating Artemis window changed or closed.');
    }
  }

  #handle<Args extends unknown[], Output>(
    channel: string,
    schema: z.ZodType<Args>,
    operation: (event: IpcMainInvokeEvent, ...args: Args) => Output | Promise<Output>,
  ): void {
    ipcMain.handle(channel, async (event, ...raw: unknown[]): Promise<IpcResult<Output>> => {
      try {
        const args = schema.parse(raw);
        const value = await operation(event, ...args);
        return { ok: true, value };
      } catch (error) {
        return {
          ok: false,
          error: {
            code: error instanceof z.ZodError ? 'INVALID_REQUEST' : 'OPERATION_FAILED',
            message:
              error instanceof z.ZodError
                ? 'Artemis rejected invalid voice audio.'
                : error instanceof Error
                  ? error.message
                  : 'The voice operation failed.',
          },
        };
      }
    });
    this.#registered.push(channel);
  }
}

async function loadTransformers(): Promise<TransformersModule> {
  return (await import('@huggingface/transformers')) as unknown as TransformersModule;
}

function configureTransformers(
  transformers: TransformersModule,
  cacheDirectory: string,
  allowRemote: boolean,
): void {
  transformers.env.cacheDir = cacheDirectory;
  transformers.env.allowLocalModels = true;
  transformers.env.allowRemoteModels = allowRemote;
}

function createPipeline(
  transformers: TransformersModule,
  localOnly: boolean,
): Promise<VoicePipeline> {
  return transformers
    .pipeline('automatic-speech-recognition', VOICE_MODEL_ID, {
      revision: VOICE_MODEL_REVISION,
      dtype: 'q8',
      local_files_only: localOnly,
    })
    .then((value) => value as VoicePipeline);
}

function modelDownloadDisclosure(): OutboundActionDisclosure {
  return {
    action: 'voice-model-download',
    title: 'Install local voice model',
    summary: 'Allow Artemis to download Whisper Tiny English for offline speech recognition?',
    confirmLabel: 'Download model',
    destination: {
      kind: 'model-registry',
      endpoint: 'huggingface.co',
      resource: `${VOICE_MODEL_ID}@${VOICE_MODEL_REVISION}`,
      transport: 'HTTPS',
    },
    details: [
      { label: 'Runtime', value: 'Transformers.js with ONNX Runtime' },
      {
        label: 'After installation',
        value: 'Transcription runs locally with networking disabled',
      },
    ],
    warning:
      'The model registry may serve model files through its content-delivery hosts. No project files, recordings, prompts, credentials, or transcripts are uploaded.',
  };
}
