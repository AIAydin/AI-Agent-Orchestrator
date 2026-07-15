import { constants } from 'node:fs';

// libuv does not support these POSIX-only guards on Windows. Canonical-path equality remains the
// symlink/directory guard there; POSIX adds kernel checks immediately before opening.
export const NO_FOLLOW_FLAG = process.platform === 'win32' ? 0 : constants.O_NOFOLLOW;
export const DIRECTORY_FLAG = process.platform === 'win32' ? 0 : constants.O_DIRECTORY;
