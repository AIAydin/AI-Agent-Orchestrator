export interface ResolvedRuntimeLaunch {
  readonly executable: string;
  readonly arguments: readonly string[];
  readonly windowsVerbatimArguments?: true;
}

export interface ResolvedPtyLaunch {
  readonly executable: string;
  readonly arguments: readonly string[];
  readonly environment: NodeJS.ProcessEnv;
}

const WINDOWS_BATCH_PTY_BRIDGE = [
  "const { spawn } = process.getBuiltinModule('node:child_process');",
  "const payload = JSON.parse(Buffer.from(process.argv[1], 'base64url').toString('utf8'));",
  'const child = spawn(payload.executable, payload.arguments, {',
  "  env: process.env, shell: false, stdio: 'inherit', windowsHide: true,",
  '  windowsVerbatimArguments: true,',
  '});',
  "child.on('error', (error) => { process.stderr.write(`${error.message}\\n`); process.exit(1); });",
  "child.on('exit', (code) => process.exit(code ?? 1));",
].join('\n');

/**
 * node-pty applies C-runtime argument escaping before CreateProcess, while cmd.exe batch shims use
 * their own incompatible quoting rules. Put a native Node/Electron process in the PTY and let that
 * bridge launch the already-validated verbatim cmd.exe command with inherited terminal handles.
 */
export function resolvePtyRuntimeLaunch(
  launch: ResolvedRuntimeLaunch,
  environment: NodeJS.ProcessEnv,
  runtimeExecutable: string = process.execPath,
): ResolvedPtyLaunch {
  if (launch.windowsVerbatimArguments !== true) {
    return {
      executable: launch.executable,
      arguments: [...launch.arguments],
      environment,
    };
  }
  const payload = Buffer.from(
    JSON.stringify({
      executable: launch.executable,
      arguments: launch.arguments,
    }),
    'utf8',
  ).toString('base64url');
  return {
    executable: runtimeExecutable,
    arguments: ['-e', WINDOWS_BATCH_PTY_BRIDGE, payload],
    environment: { ...environment, ELECTRON_RUN_AS_NODE: '1' },
  };
}
