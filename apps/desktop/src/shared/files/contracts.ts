import { RelativePathSchema } from '@forgeboard/core/domain';
import { z } from 'zod';

export const FILE_TEXT_MAX_BYTES = 4 * 1024 * 1024;
export const FILE_TREE_MAX_ENTRIES = 1_000;
export const FILE_SEARCH_MAX_QUERY_CHARACTERS = 256;
export const FILE_SEARCH_MAX_RESULTS = 200;

export const FILE_IPC_CHANNELS = Object.freeze({
  tree: 'files:tree',
  search: 'files:search',
  read: 'files:read',
  save: 'files:save',
  revert: 'files:revert',
  reveal: 'files:reveal',
  openExternal: 'files:open-external',
});

export const ProjectFileIdSchema = z.string().uuid();

export const CanonicalFilePathSchema = RelativePathSchema.refine(
  (value) =>
    value !== '.' &&
    !value.includes('\\') &&
    !value.startsWith('./') &&
    !value.endsWith('/') &&
    !value.includes('//') &&
    !value.split('/').includes('.'),
  'File paths must be canonical, forward-slash relative paths',
);

export const ProjectDirectoryPathSchema = z.union([z.literal('.'), CanonicalFilePathSchema]);

export const FileTreeInputSchema = z
  .object({
    projectId: ProjectFileIdSchema,
    directory: ProjectDirectoryPathSchema,
  })
  .strict();
export type FileTreeInput = z.infer<typeof FileTreeInputSchema>;

export const FileReadInputSchema = z
  .object({
    projectId: ProjectFileIdSchema,
    relativePath: CanonicalFilePathSchema,
  })
  .strict();
export type FileReadInput = z.infer<typeof FileReadInputSchema>;

export const FileSaveInputSchema = FileReadInputSchema.extend({
  content: z.string().max(FILE_TEXT_MAX_BYTES),
  expectedSha256: z.string().regex(/^[0-9a-f]{64}$/),
}).strict();
export type FileSaveInput = z.infer<typeof FileSaveInputSchema>;

export const FileRevertInputSchema = FileReadInputSchema;
export type FileRevertInput = z.infer<typeof FileRevertInputSchema>;

export const FileRevealInputSchema = FileReadInputSchema;
export type FileRevealInput = z.infer<typeof FileRevealInputSchema>;

export const FileOpenExternalInputSchema = FileReadInputSchema;
export type FileOpenExternalInput = z.infer<typeof FileOpenExternalInputSchema>;

export const FileSearchInputSchema = z
  .object({
    projectId: ProjectFileIdSchema,
    query: z
      .string()
      .trim()
      .min(2)
      .max(FILE_SEARCH_MAX_QUERY_CHARACTERS)
      .refine(hasNoControlCharacters, 'Search text contains control characters'),
  })
  .strict();
export type FileSearchInput = z.infer<typeof FileSearchInputSchema>;

export const FileSearchMatchSchema = z
  .object({
    relativePath: CanonicalFilePathSchema,
    line: z.number().int().positive(),
    column: z.number().int().positive(),
    preview: z.string().max(500),
  })
  .strict();
export type FileSearchMatch = z.infer<typeof FileSearchMatchSchema>;

export const FileSearchResultSchema = z
  .object({
    projectId: ProjectFileIdSchema,
    query: z.string().min(2).max(FILE_SEARCH_MAX_QUERY_CHARACTERS),
    matches: z.array(FileSearchMatchSchema).max(FILE_SEARCH_MAX_RESULTS),
    scannedFiles: z.number().int().nonnegative(),
    skippedFiles: z.number().int().nonnegative(),
    truncated: z.boolean(),
  })
  .strict();
export type FileSearchResult = z.infer<typeof FileSearchResultSchema>;

export const FileEntryPolicySchema = z
  .object({
    status: z.enum(['normal', 'ignored', 'sensitive', 'symlink']),
    reason: z.string().min(1).max(1_000).nullable(),
  })
  .strict();
export type FileEntryPolicy = z.infer<typeof FileEntryPolicySchema>;

export const FileTreeEntrySchema = z
  .object({
    name: z.string().min(1).max(1_024),
    relativePath: CanonicalFilePathSchema,
    kind: z.enum(['file', 'directory', 'symlink', 'other']),
    sizeBytes: z.number().int().nonnegative().nullable(),
    modifiedAt: z.string().datetime().nullable(),
    policy: FileEntryPolicySchema,
    canOpen: z.boolean(),
  })
  .strict();
export type FileTreeEntry = z.infer<typeof FileTreeEntrySchema>;

export const FileTreeResultSchema = z
  .object({
    projectId: ProjectFileIdSchema,
    directory: ProjectDirectoryPathSchema,
    entries: z.array(FileTreeEntrySchema).max(FILE_TREE_MAX_ENTRIES),
    truncated: z.boolean(),
  })
  .strict();
export type FileTreeResult = z.infer<typeof FileTreeResultSchema>;

export const FileDocumentSchema = z
  .object({
    projectId: ProjectFileIdSchema,
    relativePath: CanonicalFilePathSchema,
    contentKind: z.enum(['text', 'binary', 'too-large']),
    content: z.string().nullable(),
    encoding: z.literal('utf-8').nullable(),
    sizeBytes: z.number().int().nonnegative(),
    modifiedAt: z.string().datetime(),
    sha256: z
      .string()
      .regex(/^[0-9a-f]{64}$/)
      .nullable(),
    readOnly: z.boolean(),
    readOnlyReason: z.string().min(1).max(1_000).nullable(),
  })
  .strict()
  .superRefine((document, context) => {
    if (
      document.contentKind === 'text' &&
      (document.content === null ||
        document.encoding !== 'utf-8' ||
        document.sha256 === null ||
        document.readOnlyReason !== null)
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Editable text documents require content, UTF-8 encoding, and a content hash',
      });
    }
    if (
      document.contentKind !== 'text' &&
      (document.content !== null || document.encoding !== null || !document.readOnly)
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Binary and oversized documents must remain content-free and read-only',
      });
    }
    if (document.contentKind === 'too-large' && document.sha256 !== null) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Oversized documents are not hashed by the bounded reader',
      });
    }
  });
export type FileDocument = z.infer<typeof FileDocumentSchema>;

export const FileDomainErrorCodeSchema = z.enum([
  'INVALID_REQUEST',
  'PROJECT_NOT_FOUND',
  'PROJECT_MISSING',
  'PROJECT_ROOT_UNAVAILABLE',
  'PATH_OUTSIDE_PROJECT',
  'PATH_NOT_CANONICAL',
  'FILE_NOT_FOUND',
  'NOT_A_FILE',
  'NOT_A_DIRECTORY',
  'IGNORED_FILE',
  'SENSITIVE_FILE',
  'SYMLINK_BLOCKED',
  'FILE_TOO_LARGE',
  'BINARY_FILE',
  'STALE_CONTENT',
  'IO_ERROR',
]);
export type FileDomainErrorCode = z.infer<typeof FileDomainErrorCodeSchema>;

export const FileIpcErrorSchema = z
  .object({
    code: FileDomainErrorCodeSchema,
    message: z.string().min(1).max(1_000),
  })
  .strict();
export type FileIpcError = z.infer<typeof FileIpcErrorSchema>;

export type FileIpcResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: FileIpcError };

export function fileIpcResultSchema<Schema extends z.ZodTypeAny>(
  valueSchema: Schema,
): z.ZodType<FileIpcResult<z.output<Schema>>, z.ZodTypeDef, unknown> {
  return z.discriminatedUnion('ok', [
    z.object({ ok: z.literal(true), value: valueSchema }).strict(),
    z.object({ ok: z.literal(false), error: FileIpcErrorSchema }).strict(),
  ]) as unknown as z.ZodType<FileIpcResult<z.output<Schema>>, z.ZodTypeDef, unknown>;
}

function hasNoControlCharacters(value: string): boolean {
  for (const character of value) {
    const codePoint = character.codePointAt(0);
    if (codePoint !== undefined && (codePoint <= 31 || codePoint === 127)) return false;
  }
  return true;
}
