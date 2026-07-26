import path from 'node:path';

import { resolveCanonicalPath } from '@forgeboard/core';
import type { Dialog } from 'electron';

import {
  PROJECT_IMAGE_MAX_BYTES,
  ProjectImageChooseInputSchema,
  ProjectImageLoadInputSchema,
  ProjectImageLoadResultSchema,
  type ProjectImageChooseInput,
  type ProjectImageLoadInput,
  type ProjectImageLoadResult,
  type ProjectImageReference,
} from '../../../shared/files/images/contracts.js';
import { resolveProjectFileRoot, type FileProjectStore } from '../authority.js';
import { FileDomainError, fileDomainBoundary, normalizeFileDomainError } from '../errors.js';
import { assertFileContentNotSensitive } from '../policy.js';
import { readStableProjectImage, type ProjectImageReaderIo } from './reader.js';

type ImageDialog = Pick<Dialog, 'showOpenDialog'>;

/** Trusted image authority. Absolute paths and raw file bytes never leave the main process. */
export class ProjectImageService {
  public constructor(
    private readonly store: FileProjectStore,
    private readonly dialog: ImageDialog,
    private readonly readerIo: ProjectImageReaderIo = {},
  ) {}

  public async choose(
    input: ProjectImageChooseInput,
    assertCurrent: () => void,
  ): Promise<ProjectImageReference | null> {
    return await fileDomainBoundary(async () => {
      const parsed = ProjectImageChooseInputSchema.parse(input);
      const root = await resolveProjectFileRoot(this.store, parsed.projectId);
      assertCurrent();
      const selection = await this.dialog.showOpenDialog({
        title: 'Choose an image from this project',
        defaultPath: root,
        buttonLabel: 'Use image',
        properties: ['openFile'],
        filters: [{ name: 'Images', extensions: ['png', 'jpg', 'jpeg', 'gif', 'webp'] }],
      });
      assertCurrent();
      const selectedPath = selection.filePaths[0];
      if (selection.canceled || selectedPath === undefined) return null;

      const canonical = await resolveCanonicalPath(root, selectedPath, {
        mustExist: true,
        allowAbsolute: true,
      });
      const lexicalRelativePath = path
        .relative(root, path.resolve(selectedPath))
        .split(path.sep)
        .join('/');
      if (lexicalRelativePath !== canonical.relativePath) {
        throw new FileDomainError(
          'SYMLINK_BLOCKED',
          'Choose an ordinary project image rather than a symbolic-link shortcut.',
        );
      }
      if (canonical.relativePath === '' || path.isAbsolute(canonical.relativePath)) {
        throw new FileDomainError('PATH_OUTSIDE_PROJECT', 'Choose an image inside this project.');
      }
      const loaded = await this.#loadParsed({
        projectId: parsed.projectId,
        relativePath: canonical.relativePath,
      });
      assertCurrent();
      if (loaded.view.status !== 'available') {
        throw new FileDomainError('NOT_A_FILE', loaded.view.message);
      }
      if (loaded.sha256 === undefined) {
        throw new FileDomainError('IO_ERROR', 'Forgeboard could not verify the selected image.');
      }
      return {
        projectId: parsed.projectId,
        relativePath: canonical.relativePath,
        kind: 'image',
        missing: false,
        lastKnownHash: loaded.sha256,
      };
    });
  }

  public async load(input: ProjectImageLoadInput): Promise<ProjectImageLoadResult> {
    return await fileDomainBoundary(async () => {
      const parsed = ProjectImageLoadInputSchema.parse(input);
      return (await this.#loadParsed(parsed)).view;
    });
  }

  async #loadParsed(
    input: ProjectImageLoadInput,
  ): Promise<{ readonly view: ProjectImageLoadResult; readonly sha256?: string }> {
    const root = await resolveProjectFileRoot(this.store, input.projectId);
    assertFileContentNotSensitive(input.relativePath);
    try {
      const loaded = await readStableProjectImage(
        root,
        input.relativePath,
        PROJECT_IMAGE_MAX_BYTES,
        this.readerIo,
      );
      if (loaded.status === 'unavailable') {
        return {
          view: ProjectImageLoadResultSchema.parse({
            status: 'unavailable',
            projectId: input.projectId,
            relativePath: input.relativePath,
            message: loaded.message,
          }),
        };
      }
      return {
        view: ProjectImageLoadResultSchema.parse({
          status: 'available',
          projectId: input.projectId,
          relativePath: input.relativePath,
          dataUrl: `data:${loaded.image.mimeType};base64,${loaded.image.bytes.toString('base64')}`,
        }),
        sha256: loaded.image.sha256,
      };
    } catch (cause) {
      const failure = normalizeFileDomainError(cause);
      if (failure.code === 'FILE_NOT_FOUND') {
        return {
          view: ProjectImageLoadResultSchema.parse({
            status: 'missing',
            projectId: input.projectId,
            relativePath: input.relativePath,
            message: 'This image is missing or moved. Choose its new location to reconnect it.',
          }),
        };
      }
      throw failure;
    }
  }
}
