import { createHash } from "node:crypto";
import path from "node:path";

import {
  AGENT_CONTEXT_ATTACHMENT_LIMIT,
  buildAttachmentManifest,
  type AttachmentManifest,
  type CanvasNode,
} from "@forgeboard/core";

import type {
  AppSettings,
  PrepareRunInput,
} from "../../../shared/application/contracts.js";
import { synchronizeCanvasDocument } from "../../../shared/canvas/adapter.js";
import type { AgentExecutionContextRequest } from "../../agent-execution/contracts.js";
import {
  AGENT_CONTEXT_FILE_MAX_BYTES,
  AGENT_CONTEXT_TOTAL_MAX_BYTES,
} from "../../agent-execution/context/limits.js";
import { resolveProjectFileRoot } from "../../file-domain/authority.js";
import type { LocalStore } from "../../storage.js";

export type PersistedAgentContextStore = Pick<
  LocalStore,
  "appendAudit" | "getProject" | "loadCanvas"
>;

export interface PersistedAgentContextAuthority {
  readonly attachmentIds: readonly string[];
  readonly canvasId: string;
  readonly fingerprint: string;
  readonly manifestDigest: string | null;
  readonly relativePaths: readonly string[];
}

export interface PersistedAgentContextResolution {
  readonly authority: PersistedAgentContextAuthority;
  readonly context: AgentExecutionContextRequest;
}

export interface AgentRunContextResolver {
  resolve(
    input: PrepareRunInput,
    settings: AppSettings,
  ): Promise<PersistedAgentContextResolution>;
}

export function assertPersistedAgentNodeMutable(
  store: Pick<LocalStore, "loadCanvas">,
  projectId: string,
  nodeId: string,
  expectedRunId?: string,
): void {
  const stored = store.loadCanvas(projectId);
  if (stored === undefined)
    throw new Error("The Agent canvas is no longer available.");
  const synchronized = synchronizeCanvasDocument(stored);
  if (!synchronized.ok) {
    throw new Error(
      "The saved canvas is invalid. Repair it before controlling an Agent run.",
    );
  }
  const canvas = synchronized.document.canonical;
  if (canvas.projectId !== projectId)
    throw new Error("The saved canvas belongs to another project.");
  const agent = canvas.nodes.find((node) => node.id === nodeId);
  if (agent === undefined || agent.type !== "agent") {
    throw new Error("Agent controls require an exact persisted Agent node.");
  }
  if (protectedNodeIds(canvas.nodes).has(nodeId)) {
    throw new Error(
      "Unlock the Agent node or its containing group before controlling it.",
    );
  }
  if (
    expectedRunId !== undefined &&
    persistedAgentRunId(agent) !== expectedRunId
  ) {
    throw new Error(
      "The Agent node now points to another run. Use its current controls.",
    );
  }
}

export function assertPersistedAgentLaunchAuthorityCurrent(
  store: Pick<LocalStore, "loadCanvas">,
  input: PrepareRunInput,
  settings: AppSettings,
  expectedRunId: string,
  expected: PersistedAgentContextAuthority,
): void {
  assertPersistedAgentNodeMutable(
    store,
    input.projectId,
    input.nodeId,
    expectedRunId,
  );
  const stored = store.loadCanvas(input.projectId);
  if (stored === undefined)
    throw new Error("The Agent canvas is no longer available.");
  const synchronized = synchronizeCanvasDocument(stored);
  if (!synchronized.ok) throw new Error("The saved Agent canvas is invalid.");
  const canvas = synchronized.document.canonical;
  const agent = canvas.nodes.find((node) => node.id === input.nodeId);
  if (agent === undefined || agent.type !== "agent") {
    throw new Error(
      "Agent launch authority no longer resolves to the reviewed node.",
    );
  }
  assertPreparedConfiguration(agent, input, settings);
  const attachmentIds = [...agent.data.contextAttachmentIds];
  const relativePaths = attachmentIds.map(
    (attachmentId) =>
      requireContextNode(canvas.nodes, input.projectId, attachmentId).data.file
        .relativePath,
  );
  if (
    canvas.id !== expected.canvasId ||
    JSON.stringify(attachmentIds) !== JSON.stringify(expected.attachmentIds) ||
    JSON.stringify(relativePaths) !== JSON.stringify(expected.relativePaths)
  ) {
    throw new Error(
      "The Agent context selection changed after review. Review a fresh run.",
    );
  }
}

/** Main-only authority that turns persisted opaque File-node IDs into reviewed file bytes. */
export class PersistedAgentRunContextResolver
  implements AgentRunContextResolver
{
  public constructor(private readonly store: PersistedAgentContextStore) {}

  public async resolve(
    input: PrepareRunInput,
    settings: AppSettings,
  ): Promise<PersistedAgentContextResolution> {
    try {
      const resolution = await this.#resolve(input, settings);
      this.store.appendAudit("agent-run-context", "resolve", "allowed", {
        projectId: input.projectId,
        nodeId: input.nodeId,
        adapterId: input.adapterId,
        canvasId: resolution.authority.canvasId,
        attachmentIds: [...resolution.authority.attachmentIds],
        manifestDigest: resolution.authority.manifestDigest,
      });
      return resolution;
    } catch (error) {
      this.store.appendAudit("agent-run-context", "resolve", "denied", {
        projectId: input.projectId,
        nodeId: input.nodeId,
        adapterId: input.adapterId,
        reason: errorMessage(error),
      });
      throw error;
    }
  }

  async #resolve(
    input: PrepareRunInput,
    settings: AppSettings,
  ): Promise<PersistedAgentContextResolution> {
    const projectRoot = await resolveProjectFileRoot(
      this.store,
      input.projectId,
    );
    const stored = this.store.loadCanvas(input.projectId);
    if (stored === undefined) {
      throw new Error("Save this canvas before reviewing an Agent run.");
    }
    const synchronized = synchronizeCanvasDocument(stored);
    if (!synchronized.ok) {
      throw new Error(
        "The saved canvas is invalid. Repair it before reviewing an Agent run.",
      );
    }
    const canvas = synchronized.document.canonical;
    if (canvas.projectId !== input.projectId) {
      throw new Error("The saved canvas belongs to another project.");
    }
    const agent = canvas.nodes.find((node) => node.id === input.nodeId);
    if (agent === undefined || agent.type !== "agent") {
      throw new Error(
        "Agent runs require an Agent node on the saved canvas. Save and review what will run.",
      );
    }
    if (protectedNodeIds(canvas.nodes).has(agent.id)) {
      throw new Error(
        "Unlock the Agent node or its containing group before reviewing a run.",
      );
    }
    assertPreparedConfiguration(agent, input, settings);

    const attachmentIds = [...agent.data.contextAttachmentIds];
    if (attachmentIds.length > AGENT_CONTEXT_ATTACHMENT_LIMIT) {
      throw new Error(
        `Agent context supports at most ${String(AGENT_CONTEXT_ATTACHMENT_LIMIT)} files.`,
      );
    }
    if (new Set(attachmentIds).size !== attachmentIds.length) {
      throw new Error("Agent context contains duplicate File-node IDs.");
    }
    const files = attachmentIds.map((attachmentId) =>
      requireContextNode(canvas.nodes, input.projectId, attachmentId),
    );
    const relativePaths = files.map((node) => node.data.file.relativePath);
    if (new Set(relativePaths).size !== relativePaths.length) {
      throw new Error(
        "Agent context cannot contain two File nodes for the same project path.",
      );
    }

    const manifest =
      relativePaths.length === 0
        ? null
        : await buildAttachmentManifest({
            projectId: input.projectId,
            projectRoot,
            receivingAdapterId: input.adapterId,
            receivingProvider: input.adapterId,
            relativePaths,
          });
    if (manifest !== null) assertContextSizeLimits(manifest, files);
    const digest =
      manifest === null ? null : attachmentManifestDigest(manifest);
    const context: AgentExecutionContextRequest =
      manifest === null
        ? { attachments: [] }
        : {
            attachments: files.map((node, index) => {
              const selected = manifest.files[index];
              if (
                selected === undefined ||
                selected.relativePath !== relativePaths[index]
              ) {
                throw new Error(
                  `The context manifest omitted File node "${node.id}".`,
                );
              }
              const videoContent =
                node.type === "video" ? videoContextNote(selected) : null;
              return {
                path:
                  videoContent === null
                    ? selected.canonicalPath
                    : path.join(
                        projectRoot,
                        ".forgeboard-context",
                        `video-${node.id}.md`,
                      ),
                kind: "file" as const,
                label:
                  videoContent === null
                    ? node.title
                    : `${node.title} video context`,
                explicitlyApproved: true as const,
                sha256:
                  videoContent === null
                    ? selected.sha256
                    : stableDigest(videoContent),
              };
            }),
            generatedArtifacts: files.flatMap((node, index) => {
              if (node.type !== "video") return [];
              const selected = manifest.files[index];
              if (selected === undefined)
                throw new Error(
                  `The context manifest omitted Video node "${node.id}".`,
                );
              const content = videoContextNote(selected);
              return [
                {
                  path: path.join(
                    projectRoot,
                    ".forgeboard-context",
                    `video-${node.id}.md`,
                  ),
                  content,
                  sha256: stableDigest(content),
                },
              ];
            }),
            manifestId: manifest.id,
            manifestDigest: attachmentManifestDigest(manifest),
          };
    const authority: PersistedAgentContextAuthority = {
      attachmentIds,
      canvasId: canvas.id,
      manifestDigest: digest,
      relativePaths,
      fingerprint: stableDigest({
        schemaVersion: 1,
        projectId: input.projectId,
        canvasId: canvas.id,
        nodeId: input.nodeId,
        adapterId: input.adapterId,
        model: input.model ?? null,
        permissionProfile: input.permissionProfile,
        promptDigest: stableDigest(input.prompt),
        attachmentIds,
        files:
          manifest?.files.map((file, index) => ({
            attachmentId: attachmentIds[index],
            label: files[index]?.title,
            kind: files[index]?.type ?? "file",
            relativePath: file.relativePath,
            sizeBytes: file.sizeBytes,
            sha256: file.sha256,
            policy: file.policy,
            overrideApprovalId: file.overrideApprovalId ?? null,
          })) ?? [],
        manifestDigest: digest,
      }),
    };
    return { authority, context };
  }
}

function protectedNodeIds(nodes: readonly CanvasNode[]): ReadonlySet<string> {
  const protectedIds = new Set(
    nodes.filter((node) => node.locked).map((node) => node.id),
  );
  let changed = true;
  while (changed) {
    changed = false;
    for (const node of nodes) {
      if (node.type !== "group-frame" || !protectedIds.has(node.id)) continue;
      for (const childId of node.data.childNodeIds) {
        if (protectedIds.has(childId)) continue;
        protectedIds.add(childId);
        changed = true;
      }
    }
  }
  return protectedIds;
}

function assertPreparedConfiguration(
  agent: Extract<CanvasNode, { type: "agent" }>,
  input: PrepareRunInput,
  settings: AppSettings,
): void {
  const prompt = persistedAgentPrompt(agent);
  const adapterId = agent.data.adapterId ?? settings.defaultAgent;
  const model =
    agent.data.model?.trim() ||
    settings.agentDefaultModels?.[adapterId]?.trim() ||
    undefined;
  const permissionProfile =
    agent.data.permissionProfileId ?? settings.defaultPermissionProfile;
  if (prompt !== input.prompt) {
    throw new Error(
      "The saved Agent prompt changed. Save and review what will run.",
    );
  }
  if (adapterId !== input.adapterId) {
    throw new Error(
      "The saved Agent adapter changed. Save and review what will run.",
    );
  }
  if (model !== input.model) {
    throw new Error(
      "The saved Agent model changed. Save and review a fresh run.",
    );
  }
  if (permissionProfile !== input.permissionProfile) {
    throw new Error(
      "The saved Agent permission profile changed. Save and review what will run.",
    );
  }
}

function persistedAgentPrompt(
  agent: Extract<CanvasNode, { type: "agent" }>,
): string {
  const typedPrompt = agent.data.promptDraft.trim();
  if (typedPrompt.length > 0) return typedPrompt;
  const legacyData = agent.inspector["legacyData"];
  if (
    legacyData === null ||
    typeof legacyData !== "object" ||
    Array.isArray(legacyData)
  ) {
    return typedPrompt;
  }
  const record = legacyData as Readonly<Record<string, unknown>>;
  if (typeof record["prompt"] === "string") return record["prompt"].trim();
  return typeof record["description"] === "string"
    ? record["description"].trim()
    : typedPrompt;
}

function persistedAgentRunId(
  agent: Extract<CanvasNode, { type: "agent" }>,
): string | undefined {
  const legacyData = agent.inspector["legacyData"];
  if (
    legacyData === null ||
    typeof legacyData !== "object" ||
    Array.isArray(legacyData)
  ) {
    return undefined;
  }
  const runId = (legacyData as Readonly<Record<string, unknown>>)["runId"];
  return typeof runId === "string" ? runId : undefined;
}

function requireContextNode(
  nodes: readonly CanvasNode[],
  projectId: string,
  attachmentId: string,
): ConfiguredContextNode {
  const node = nodes.find((candidate) => candidate.id === attachmentId);
  if (node === undefined) {
    throw new Error(
      `Agent context attachment "${attachmentId}" no longer exists.`,
    );
  }
  if (
    (node.type !== "file" && node.type !== "video") ||
    node.data.file === undefined
  ) {
    throw new Error(
      `Agent context attachment "${attachmentId}" must be a configured File or Video node.`,
    );
  }
  if (node.data.file.projectId !== projectId) {
    throw new Error(
      `Agent context attachment "${attachmentId}" belongs to another project.`,
    );
  }
  if (node.data.file.missing) {
    throw new Error(
      `Agent context attachment "${attachmentId}" is marked as missing.`,
    );
  }
  if (node.data.file.kind !== "file") {
    throw new Error(
      `Agent context attachment "${attachmentId}" must be an ordinary file.`,
    );
  }
  return node as ConfiguredContextNode;
}

type ContextNode = Extract<CanvasNode, { type: "file" | "video" }>;
type ConfiguredContextNode = ContextNode & {
  readonly data: ContextNode["data"] & {
    readonly file: NonNullable<ContextNode["data"]["file"]>;
  };
};

function attachmentManifestDigest(manifest: AttachmentManifest): string {
  return stableDigest(
    [...manifest.files]
      .sort((left, right) =>
        left.relativePath.localeCompare(right.relativePath),
      )
      .map((file) => ({
        relativePath: file.relativePath,
        sizeBytes: file.sizeBytes,
        sha256: file.sha256,
        policy: file.policy,
        overrideApprovalId: file.overrideApprovalId ?? null,
      })),
  );
}

function assertContextSizeLimits(
  manifest: AttachmentManifest,
  nodes: readonly ConfiguredContextNode[],
): void {
  let totalBytes = 0;
  for (const [index, file] of manifest.files.entries()) {
    if (nodes[index]?.type === "video") continue;
    if (file.sizeBytes > AGENT_CONTEXT_FILE_MAX_BYTES) {
      throw new Error(
        `Agent context file "${file.relativePath}" exceeds the ${formatBytes(AGENT_CONTEXT_FILE_MAX_BYTES)} per-file limit.`,
      );
    }
    totalBytes += file.sizeBytes;
    if (totalBytes > AGENT_CONTEXT_TOTAL_MAX_BYTES) {
      throw new Error(
        `Agent context exceeds the ${formatBytes(AGENT_CONTEXT_TOTAL_MAX_BYTES)} aggregate limit.`,
      );
    }
  }
}

function videoContextNote(file: AttachmentManifest["files"][number]): string {
  return [
    "# Forgeboard video context",
    "",
    "The user explicitly shared this project video with this agent.",
    `Project-relative path: ${file.relativePath}`,
    `SHA-256: ${file.sha256}`,
    `Size: ${String(file.sizeBytes)} bytes`,
    "",
    "Open the original video at the project-relative path when your tools support video access.",
    "Forgeboard did not copy, transcribe, or claim to understand the video automatically.",
    "",
  ].join("\n");
}

function formatBytes(bytes: number): string {
  return `${String(bytes / (1024 * 1024))} MiB`;
}

function stableDigest(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function errorMessage(error: unknown): string {
  return error instanceof Error
    ? error.message.slice(0, 20_000)
    : "Unknown context error";
}
