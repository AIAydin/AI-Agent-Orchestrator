import { AGENT_CONTEXT_ATTACHMENT_LIMIT } from '@forgeboard/core';

import { FILE_TEXT_MAX_BYTES } from '../../../shared/files/contracts.js';

/** Context selected through the bounded file UI must stay within the same per-file read ceiling. */
export const AGENT_CONTEXT_FILE_MAX_BYTES = FILE_TEXT_MAX_BYTES;

/** Matches the existing bounded project-search aggregate read budget. */
export const AGENT_CONTEXT_TOTAL_MAX_BYTES = 32 * 1024 * 1024;

export { AGENT_CONTEXT_ATTACHMENT_LIMIT };
