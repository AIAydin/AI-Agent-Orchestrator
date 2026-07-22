import { createHash } from 'node:crypto';

interface TrustedTerminalLaunchInput {
  readonly executable: {
    readonly path: string;
    readonly device: number;
    readonly inode: number;
    readonly size: number;
    readonly mode: number;
    readonly digest: string;
  };
  readonly arguments: readonly string[];
  readonly cwd: {
    readonly path: string;
    readonly device: number;
    readonly inode: number;
    readonly mode: number;
  };
  readonly environmentVariableNames: readonly string[];
}

/** Stable exact-scope identity for a user-trusted, unsandboxed terminal launch. */
export function trustedTerminalLaunchFingerprint(input: TrustedTerminalLaunchInput): string {
  const canonical = JSON.stringify({
    version: 1,
    executable: {
      path: input.executable.path,
      device: input.executable.device,
      inode: input.executable.inode,
      size: input.executable.size,
      mode: input.executable.mode,
      digest: input.executable.digest,
    },
    arguments: [...input.arguments],
    cwd: {
      path: input.cwd.path,
      device: input.cwd.device,
      inode: input.cwd.inode,
      mode: input.cwd.mode,
    },
    environmentVariableNames: [...new Set(input.environmentVariableNames)].sort(),
  });
  return createHash('sha256').update(canonical, 'utf8').digest('hex');
}
