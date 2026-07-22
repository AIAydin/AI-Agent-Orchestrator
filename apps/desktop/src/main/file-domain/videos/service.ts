import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import {
  copyFile,
  lstat,
  mkdir,
  open,
  realpath,
  stat,
  unlink,
} from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

import {
  loadProjectIgnoreMatcher,
  resolveCanonicalPath,
} from "@forgeboard/core";
import type { Dialog } from "electron";

import {
  PROJECT_VIDEO_SCHEME,
  PROJECT_VIDEO_TOKEN_TTL_MS,
  ProjectVideoChooseInputSchema,
  ProjectVideoInputSchema,
  ProjectVideoLoadResultSchema,
  type ProjectVideoChooseInput,
  type ProjectVideoInput,
  type ProjectVideoLoadResult,
  type ProjectVideoReference,
} from "../../../shared/files/videos/contracts.js";
import { resolveProjectFileRoot, type FileProjectStore } from "../authority.js";
import {
  FileDomainError,
  fileDomainBoundary,
  normalizeFileDomainError,
} from "../errors.js";
import { assertFileContentAllowed } from "../policy.js";

type VideoDialog = Pick<Dialog, "showOpenDialog">;

interface PlaybackGrant {
  readonly projectId: string;
  readonly relativePath: string;
  expiresAt: number;
}

const MAX_PLAYBACK_GRANTS = 256;

/** Trusted project-video chooser and opaque streaming-capability issuer. */
export class ProjectVideoService {
  readonly #grants = new Map<string, PlaybackGrant>();

  public constructor(
    private readonly store: FileProjectStore,
    private readonly dialog: VideoDialog,
    private readonly now: () => number = Date.now,
  ) {}

  public async choose(
    input: ProjectVideoChooseInput,
    assertCurrent: () => void,
  ): Promise<ProjectVideoReference | null> {
    return await fileDomainBoundary(async () => {
      const parsed = ProjectVideoChooseInputSchema.parse(input);
      const root = await resolveProjectFileRoot(this.store, parsed.projectId);
      assertCurrent();
      const selection = await this.dialog.showOpenDialog({
        title: "Choose a video",
        defaultPath: root,
        buttonLabel: "Use video",
        properties: ["openFile"],
        filters: [
          {
            name: "Videos",
            extensions: ["mp4", "m4v", "mov", "webm", "ogv", "ogg"],
          },
        ],
      });
      assertCurrent();
      const selectedPath = selection.filePaths[0];
      if (selection.canceled || selectedPath === undefined) return null;
      const relativePath = await chooseOrImportProjectVideo(root, selectedPath);
      await inspectVideo(root, relativePath);
      assertCurrent();
      return {
        projectId: parsed.projectId,
        relativePath,
        kind: "file",
        missing: false,
      };
    });
  }

  public async load(input: ProjectVideoInput): Promise<ProjectVideoLoadResult> {
    return await fileDomainBoundary(async () => {
      const parsed = ProjectVideoInputSchema.parse(input);
      const root = await resolveProjectFileRoot(this.store, parsed.projectId);
      try {
        const inspected = await inspectVideo(root, parsed.relativePath);
        const token = this.#issue(parsed.projectId, inspected.relativePath);
        return ProjectVideoLoadResultSchema.parse({
          status: "available",
          projectId: parsed.projectId,
          relativePath: inspected.relativePath,
          playbackUrl: `${PROJECT_VIDEO_SCHEME}://media/${token}`,
          mimeType: inspected.mimeType,
          sizeBytes: inspected.sizeBytes,
        });
      } catch (cause) {
        const failure = normalizeFileDomainError(cause);
        if (failure.code === "FILE_NOT_FOUND") {
          return ProjectVideoLoadResultSchema.parse({
            status: "missing",
            projectId: parsed.projectId,
            relativePath: parsed.relativePath,
            message:
              "This video is missing or moved. Choose its new location to reconnect it.",
          });
        }
        throw failure;
      }
    });
  }

  public async fileUrlForProtocolRequest(
    requestUrl: string,
  ): Promise<string | null> {
    const url = new URL(requestUrl);
    const token =
      url.protocol === `${PROJECT_VIDEO_SCHEME}:` && url.host === "media"
        ? url.pathname.slice(1)
        : "";
    const grant = this.#grants.get(token);
    if (grant === undefined || grant.expiresAt <= this.now()) {
      this.#grants.delete(token);
      return null;
    }
    const root = await resolveProjectFileRoot(this.store, grant.projectId);
    const inspected = await inspectVideo(root, grant.relativePath);
    grant.expiresAt = this.now() + PROJECT_VIDEO_TOKEN_TTL_MS;
    return pathToFileURL(path.resolve(root, inspected.relativePath)).toString();
  }

  public clear(): void {
    this.#grants.clear();
  }

  #issue(projectId: string, relativePath: string): string {
    const now = this.now();
    for (const [token, grant] of this.#grants) {
      if (grant.expiresAt <= now) this.#grants.delete(token);
    }
    while (this.#grants.size >= MAX_PLAYBACK_GRANTS) {
      const oldest = this.#grants.keys().next().value as string | undefined;
      if (oldest === undefined) break;
      this.#grants.delete(oldest);
    }
    const token = randomUUID();
    this.#grants.set(token, {
      projectId,
      relativePath,
      expiresAt: now + PROJECT_VIDEO_TOKEN_TTL_MS,
    });
    return token;
  }
}

async function chooseOrImportProjectVideo(
  root: string,
  selectedPath: string,
): Promise<string> {
  try {
    return await canonicalProjectVideo(root, selectedPath, true);
  } catch (cause) {
    const failure = normalizeFileDomainError(cause);
    if (failure.code !== "PATH_OUTSIDE_PROJECT") throw failure;
    return await importExternalVideo(root, selectedPath);
  }
}

async function importExternalVideo(
  root: string,
  selectedPath: string,
): Promise<string> {
  const lexicalSource = path.resolve(selectedPath);
  const sourceMetadata = await lstat(lexicalSource);
  if (!sourceMetadata.isFile() || sourceMetadata.isSymbolicLink()) {
    throw new FileDomainError("NOT_A_FILE", "Choose an ordinary video file.");
  }
  const canonicalSource = await realpath(lexicalSource);
  if (canonicalSource !== lexicalSource) {
    throw new FileDomainError(
      "SYMLINK_BLOCKED",
      "Choose an ordinary video rather than a symbolic-link shortcut.",
    );
  }
  await inspectVideoFile(canonicalSource, path.basename(canonicalSource));

  const importFolder = "forgeboard-videos";
  const matcher = await loadProjectIgnoreMatcher(root);
  assertFileContentAllowed(matcher, importFolder, true);
  await mkdir(path.join(root, importFolder), { recursive: true });
  const canonicalFolder = await canonicalProjectVideoDirectory(
    root,
    importFolder,
  );
  const parsed = path.parse(path.basename(canonicalSource));
  for (let suffix = 0; suffix < 10_000; suffix += 1) {
    const fileName =
      suffix === 0
        ? `${parsed.name}${parsed.ext}`
        : `${parsed.name}-${String(suffix)}${parsed.ext}`;
    const relativePath = `${canonicalFolder}/${fileName}`;
    assertFileContentAllowed(matcher, relativePath);
    const destinationPath = path.join(root, relativePath);
    try {
      await copyFile(canonicalSource, destinationPath, constants.COPYFILE_EXCL);
      try {
        await inspectVideo(root, relativePath);
      } catch (cause) {
        await unlink(destinationPath).catch(() => undefined);
        throw cause;
      }
      return relativePath;
    } catch (cause) {
      if ((cause as NodeJS.ErrnoException).code === "EEXIST") continue;
      throw cause;
    }
  }
  throw new FileDomainError(
    "IO_ERROR",
    "Forgeboard could not choose a unique imported video name.",
  );
}

async function canonicalProjectVideoDirectory(
  root: string,
  relativePath: string,
): Promise<string> {
  const metadata = await lstat(path.join(root, relativePath));
  if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
    throw new FileDomainError(
      "SYMLINK_BLOCKED",
      "The project video import folder is not safe.",
    );
  }
  const canonical = await resolveCanonicalPath(root, relativePath, {
    mustExist: true,
    allowAbsolute: false,
  });
  if (canonical.relativePath !== relativePath) {
    throw new FileDomainError(
      "SYMLINK_BLOCKED",
      "The project video import folder is not safe.",
    );
  }
  return canonical.relativePath;
}

async function inspectVideo(
  root: string,
  candidate: string,
): Promise<{
  readonly relativePath: string;
  readonly mimeType: string;
  readonly sizeBytes: number;
}> {
  const relativePath = await canonicalProjectVideo(root, candidate, false);
  const matcher = await loadProjectIgnoreMatcher(root);
  assertFileContentAllowed(matcher, relativePath);
  const absolutePath = path.resolve(root, relativePath);
  const inspected = await inspectVideoFile(absolutePath, relativePath);
  return { relativePath, ...inspected };
}

async function inspectVideoFile(
  absolutePath: string,
  displayPath: string,
): Promise<{
  readonly mimeType: "video/mp4" | "video/webm" | "video/ogg";
  readonly sizeBytes: number;
}> {
  const metadata = await stat(absolutePath);
  if (!metadata.isFile())
    throw new FileDomainError("NOT_A_FILE", "Choose an ordinary video file.");
  const handle = await open(absolutePath, "r");
  try {
    const prefix = Buffer.alloc(12);
    const { bytesRead } = await handle.read(prefix, 0, prefix.length, 0);
    const mimeType = videoMimeType(displayPath, prefix.subarray(0, bytesRead));
    if (mimeType === null) {
      throw new FileDomainError(
        "BINARY_FILE",
        "Choose an MP4, WebM, or Ogg video file.",
      );
    }
    return { mimeType, sizeBytes: metadata.size };
  } finally {
    await handle.close();
  }
}

async function canonicalProjectVideo(
  root: string,
  candidate: string,
  allowAbsolute: boolean,
): Promise<string> {
  const canonical = await resolveCanonicalPath(root, candidate, {
    mustExist: true,
    allowAbsolute,
  });
  const lexical = path
    .relative(
      root,
      allowAbsolute ? path.resolve(candidate) : path.resolve(root, candidate),
    )
    .split(path.sep)
    .join("/");
  if (lexical !== canonical.relativePath) {
    throw new FileDomainError(
      "SYMLINK_BLOCKED",
      "Choose an ordinary project video rather than a symbolic-link shortcut.",
    );
  }
  if (
    canonical.relativePath === "" ||
    path.isAbsolute(canonical.relativePath)
  ) {
    throw new FileDomainError(
      "PATH_OUTSIDE_PROJECT",
      "Choose a video inside this project.",
    );
  }
  return canonical.relativePath;
}

function videoMimeType(
  relativePath: string,
  prefix: Buffer,
): "video/mp4" | "video/webm" | "video/ogg" | null {
  const extension = path.extname(relativePath).toLowerCase();
  if (
    [".mp4", ".m4v", ".mov"].includes(extension) &&
    prefix.subarray(4, 8).toString() === "ftyp"
  ) {
    return "video/mp4";
  }
  if (
    extension === ".webm" &&
    prefix.subarray(0, 4).equals(Buffer.from([0x1a, 0x45, 0xdf, 0xa3]))
  ) {
    return "video/webm";
  }
  if (
    [".ogv", ".ogg"].includes(extension) &&
    prefix.subarray(0, 4).toString() === "OggS"
  ) {
    return "video/ogg";
  }
  return null;
}
