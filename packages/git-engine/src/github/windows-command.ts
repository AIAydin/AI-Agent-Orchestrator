import path from 'node:path';

const SAFE_BATCH_COMPONENT = /^[^"&|<>^%!\r\n\0]*$/u;

export interface GitHubCliProcessLaunch {
  readonly executable: string;
  readonly arguments: readonly string[];
  readonly windowsVerbatimArguments?: true;
}

/**
 * Windows cannot pass a .cmd/.bat file directly to CreateProcess. This routes only a reviewed
 * batch shim and metacharacter-free arguments through cmd.exe; native executables remain direct.
 */
export function resolveGitHubCliProcessLaunch(
  executable: string,
  arguments_: readonly string[],
  environment: Readonly<NodeJS.ProcessEnv>,
  platform: NodeJS.Platform = process.platform,
): GitHubCliProcessLaunch {
  if (platform !== 'win32' || !/\.(?:bat|cmd)$/iu.test(executable)) {
    return { executable, arguments: arguments_ };
  }
  if (![executable, ...arguments_].every((value) => SAFE_BATCH_COMPONENT.test(value))) {
    throw new Error(
      'The Windows GitHub CLI command contains shell metacharacters that cannot be passed safely. Choose the underlying gh.exe program instead of its .cmd or .bat shim.',
    );
  }
  const commandProcessor =
    environmentValue(environment, 'ComSpec') ??
    path.win32.join(
      environmentValue(environment, 'SystemRoot') ?? 'C:\\Windows',
      'System32',
      'cmd.exe',
    );
  if (!path.win32.isAbsolute(commandProcessor) || !SAFE_BATCH_COMPONENT.test(commandProcessor)) {
    throw new Error('The Windows command processor path is invalid.');
  }
  const commandLine = [`""${executable}"`, ...arguments_.map((argument) => `"${argument}"`)].join(
    ' ',
  );
  return {
    executable: commandProcessor,
    arguments: ['/d', '/s', '/v:off', '/c', `${commandLine}"`],
    windowsVerbatimArguments: true,
  };
}

function environmentValue(
  environment: Readonly<NodeJS.ProcessEnv>,
  name: string,
): string | undefined {
  const normalized = name.toUpperCase();
  const matchingName = Object.keys(environment).find(
    (candidate) => candidate.toUpperCase() === normalized,
  );
  return matchingName === undefined ? undefined : environment[matchingName];
}
