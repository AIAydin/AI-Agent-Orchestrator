import type {
  FileDocument,
  FileReadInput,
  FileRevealInput,
  FileRevertInput,
  FileSaveInput,
} from '../../../../shared/files/contracts.js';

/** Narrow renderer seam. A validated preload bridge can implement this without exposing Node. */
export interface FileEditorOperations {
  readonly read: (input: FileReadInput) => Promise<FileDocument>;
  readonly save: (input: FileSaveInput) => Promise<FileDocument>;
  readonly revert: (input: FileRevertInput) => Promise<FileDocument>;
  /** Resolves only after the main process has actually invoked the native reveal action. */
  readonly reveal: (input: FileRevealInput) => Promise<void>;
}
