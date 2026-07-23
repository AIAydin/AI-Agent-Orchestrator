import { Check, LoaderCircle, Mic, MicOff, Play, Settings2, X } from 'lucide-react';
import { useEffect, useRef, useState, type MutableRefObject } from 'react';

import { VOICE_MAX_SECONDS } from '../../../../../shared/voice/contracts.js';
import type { AppSettings } from '../../../../../shared/application/contracts.js';
import { unwrap } from '../../../lib/ipc.js';
import { trapModalFocus } from '../../../lib/modal-focus.js';
import type { PaletteAction } from '../../shell/CommandPalette.js';
import { joinVoiceChunks, resampleVoiceAudio } from './audio.js';
import { matchVoiceAction, type VoiceActionMatch } from './action-matcher.js';

interface ActiveRecording {
  readonly context: AudioContext;
  readonly stream: MediaStream;
  readonly source: MediaStreamAudioSourceNode;
  readonly processor: ScriptProcessorNode;
  readonly silentGain: GainNode;
  readonly chunks: Float32Array[];
  readonly timeout: number;
}

interface VoiceCommandControlProps {
  readonly settings: AppSettings;
  readonly actions: readonly PaletteAction[];
  readonly onOpenSettings: () => void;
  readonly onError: (message: string) => void;
  readonly resolveParameterizedAction?: (transcript: string) => VoiceActionMatch | null;
}

export function VoiceCommandControl({
  settings,
  actions,
  onOpenSettings,
  onError,
  resolveParameterizedAction,
}: VoiceCommandControlProps) {
  const [state, setState] = useState<'idle' | 'requesting' | 'recording' | 'transcribing'>('idle');
  const [transcript, setTranscript] = useState('');
  const [match, setMatch] = useState<VoiceActionMatch | null>(null);
  const [autoRan, setAutoRan] = useState(false);
  const recording = useRef<ActiveRecording | null>(null);
  const dialog = useRef<HTMLDivElement>(null);

  useEffect(() => () => void stopAndDiscard(recording), []);
  useEffect(() => {
    if (transcript === '') return;
    const handleKeyDown = (event: KeyboardEvent): void => {
      if (dialog.current === null) return;
      trapModalFocus(event, dialog.current);
      if (event.key !== 'Escape') return;
      event.preventDefault();
      setTranscript('');
      setMatch(null);
      setAutoRan(false);
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [transcript]);
  if (!settings.voiceCommandsEnabled) return null;

  async function start(): Promise<void> {
    setTranscript('');
    setMatch(null);
    setAutoRan(false);
    let stream: MediaStream | null = null;
    let context: AudioContext | null = null;
    setState('requesting');
    try {
      if (!navigator.mediaDevices?.getUserMedia) {
        throw new Error('Microphone recording is unavailable on this computer.');
      }
      stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          channelCount: 1,
          echoCancellation: true,
          noiseSuppression: true,
        },
        video: false,
      });
      context = new AudioContext();
      const source = context.createMediaStreamSource(stream);
      const processor = context.createScriptProcessor(4_096, 1, 1);
      const silentGain = context.createGain();
      silentGain.gain.value = 0;
      const chunks: Float32Array[] = [];
      processor.onaudioprocess = (event) => {
        chunks.push(new Float32Array(event.inputBuffer.getChannelData(0)));
      };
      source.connect(processor);
      processor.connect(silentGain);
      silentGain.connect(context.destination);
      const timeout = window.setTimeout(() => void finish(), VOICE_MAX_SECONDS * 1_000);
      recording.current = {
        context,
        stream,
        source,
        processor,
        silentGain,
        chunks,
        timeout,
      };
      setState('recording');
    } catch (error) {
      stream?.getTracks().forEach((track) => track.stop());
      if (context !== null && context.state !== 'closed') await context.close();
      setState('idle');
      onError(error instanceof Error ? error.message : 'Forgeboard could not open the microphone.');
    }
  }

  async function finish(): Promise<void> {
    const active = recording.current;
    if (active === null) return;
    recording.current = null;
    window.clearTimeout(active.timeout);
    active.processor.onaudioprocess = null;
    active.source.disconnect();
    active.processor.disconnect();
    active.silentGain.disconnect();
    active.stream.getTracks().forEach((track) => track.stop());
    await active.context.close();
    const samples = new Float32Array(
      resampleVoiceAudio(joinVoiceChunks(active.chunks), active.context.sampleRate),
    );
    if (samples.length < 4_000) {
      setState('idle');
      onError('Hold the recording a little longer so Forgeboard can hear the command.');
      return;
    }
    setState('transcribing');
    try {
      const result = unwrap(await window.forgeboard.voice.transcribe({ samples }));
      const nextMatch =
        matchVoiceAction(result.text, actions) ?? resolveParameterizedAction?.(result.text) ?? null;
      setTranscript(result.text);
      setMatch(nextMatch);
      if (
        nextMatch !== null &&
        nextMatch.action.voiceSafety === 'safe' &&
        settings.voiceAutoRunSafeActions
      ) {
        nextMatch.action.run();
        setAutoRan(true);
      }
    } catch (error) {
      onError(error instanceof Error ? error.message : 'Local transcription failed.');
    } finally {
      setState('idle');
    }
  }

  function closeResult(): void {
    setTranscript('');
    setMatch(null);
    setAutoRan(false);
  }

  return (
    <>
      <button
        type="button"
        className={`voice-command-button ${state === 'recording' ? 'recording' : ''}`}
        aria-label={state === 'recording' ? 'Stop voice command recording' : 'Start voice command'}
        disabled={state === 'requesting' || state === 'transcribing'}
        onClick={() => (state === 'recording' ? void finish() : void start())}
      >
        {state === 'requesting' || state === 'transcribing' ? (
          <LoaderCircle className="spin" size={16} aria-hidden="true" />
        ) : state === 'recording' ? (
          <MicOff size={16} aria-hidden="true" />
        ) : (
          <Mic size={16} aria-hidden="true" />
        )}
        {state === 'recording'
          ? 'Stop & transcribe'
          : state === 'requesting'
            ? 'Opening mic…'
            : state === 'transcribing'
              ? 'Listening…'
              : 'Talk'}
      </button>

      {transcript !== '' && (
        <div className="modal-backdrop voice-command-backdrop">
          <div
            ref={dialog}
            className="voice-command-result"
            role="dialog"
            aria-modal="true"
            aria-label="Voice command result"
          >
            <header>
              <div>
                <Mic size={17} aria-hidden="true" />
                <strong>Voice command</strong>
              </div>
              <button
                className="icon-button"
                type="button"
                autoFocus
                aria-label="Close voice command"
                onClick={closeResult}
              >
                <X size={16} aria-hidden="true" />
              </button>
            </header>
            <blockquote>“{transcript}”</blockquote>
            {match === null ? (
              <div className="inline-notice" role="alert">
                <p>No registered Forgeboard action matched that phrase.</p>
                <button className="button ghost" type="button" onClick={onOpenSettings}>
                  <Settings2 size={14} aria-hidden="true" /> Voice settings
                </button>
              </div>
            ) : autoRan ? (
              <p className="voice-action-match success">
                <Check size={16} aria-hidden="true" /> Ran: {match.action.label}
              </p>
            ) : (
              <div className="voice-action-match">
                <span>
                  <small>Matched registered action</small>
                  <strong>{match.action.label}</strong>
                </span>
                <button
                  className="button primary"
                  type="button"
                  onClick={() => {
                    match.action.run();
                    closeResult();
                  }}
                >
                  <Play size={14} aria-hidden="true" /> Run action
                </button>
              </div>
            )}
          </div>
        </div>
      )}
    </>
  );
}

async function stopAndDiscard(recording: MutableRefObject<ActiveRecording | null>) {
  const active = recording.current;
  if (active === null) return;
  recording.current = null;
  window.clearTimeout(active.timeout);
  active.processor.onaudioprocess = null;
  active.stream.getTracks().forEach((track) => track.stop());
  await active.context.close();
}
