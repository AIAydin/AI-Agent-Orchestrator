import { existsSync } from 'node:fs';
import { join } from 'node:path';

export function findGoogleChromeExecutable(
  platform: NodeJS.Platform = process.platform,
  environment: NodeJS.ProcessEnv = process.env,
): string | null {
  const candidates = chromeCandidates(platform, environment);
  return candidates.find((candidate) => existsSync(candidate)) ?? null;
}

export function chromeCandidates(
  platform: NodeJS.Platform,
  environment: NodeJS.ProcessEnv,
): string[] {
  if (platform === 'darwin') {
    return [
      '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
      ...(environment['HOME']
        ? [join(environment['HOME'], 'Applications/Google Chrome.app/Contents/MacOS/Google Chrome')]
        : []),
    ];
  }
  if (platform === 'win32') {
    return [
      ...(environment['PROGRAMFILES']
        ? [join(environment['PROGRAMFILES'], 'Google/Chrome/Application/chrome.exe')]
        : []),
      ...(environment['PROGRAMFILES(X86)']
        ? [join(environment['PROGRAMFILES(X86)'], 'Google/Chrome/Application/chrome.exe')]
        : []),
      ...(environment['LOCALAPPDATA']
        ? [join(environment['LOCALAPPDATA'], 'Google/Chrome/Application/chrome.exe')]
        : []),
    ];
  }
  return [
    '/usr/bin/google-chrome',
    '/usr/bin/google-chrome-stable',
    '/opt/google/chrome/google-chrome',
  ];
}
