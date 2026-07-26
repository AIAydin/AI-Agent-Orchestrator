export interface ResolvedRuntimeLaunch {
  readonly executable: string;
  readonly arguments: readonly string[];
  readonly windowsVerbatimArguments?: true;
  readonly windowsPty?: {
    readonly arguments: readonly string[];
    readonly initialInput: string;
  };
}

export interface ResolvedPtyLaunch {
  readonly executable: string;
  readonly arguments: readonly string[];
  readonly environment: NodeJS.ProcessEnv;
  readonly initialInput?: string;
}

/**
 * node-pty applies C-runtime argument escaping before CreateProcess, while cmd.exe batch shims use
 * their own incompatible quoting rules. Start the validated command processor as the PTY and submit
 * the trusted batch command through terminal input, where cmd.exe applies its native grammar.
 */
export function resolvePtyRuntimeLaunch(
  launch: ResolvedRuntimeLaunch,
  environment: NodeJS.ProcessEnv,
): ResolvedPtyLaunch {
  const windowsPty = launch.windowsPty;
  if (windowsPty === undefined) {
    return { executable: launch.executable, arguments: [...launch.arguments], environment };
  }
  return {
    executable: launch.executable,
    arguments: [...windowsPty.arguments],
    environment,
    initialInput: `${windowsPty.initialInput}\r`,
  };
}
