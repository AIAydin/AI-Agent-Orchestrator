import { spawn } from 'node:child_process';
import { stat } from 'node:fs/promises';
import { join } from 'node:path';
import process from 'node:process';

const MAC_DEVELOPER_ID = /^Authority=Developer ID Application:/mu;
const MAC_TEAM_IDENTIFIER = /^TeamIdentifier=(.+)$/mu;
const WINDOWS_SIGNATURE_SCRIPT = String.raw`
$signature = Get-AuthenticodeSignature -LiteralPath $env:FORGEBOARD_ARTIFACT_TO_VERIFY
$result = [PSCustomObject]@{
  Status = [string]$signature.Status
  Subject = if ($null -eq $signature.SignerCertificate) { $null } else { [string]$signature.SignerCertificate.Subject }
}
[Console]::Out.Write(($result | ConvertTo-Json -Compress))
`.trim();

export function unsignedSigningSummary(platform) {
  if (platform === 'linux') {
    return {
      status: 'not-applicable',
      message: 'Linux installers are checksum-verified and are not platform-code-signed.',
    };
  }
  return {
    status: 'unsigned-development',
    message:
      'Platform verification found no trusted distribution signature on this development artifact.',
  };
}

export async function verifyPlatformSigning({
  releaseRoot,
  plan,
  platform,
  architecture,
  environment = process.env,
  runCommand = execute,
}) {
  if (platform === 'linux') return unsignedSigningSummary(platform);
  if (platform === 'darwin') {
    return await verifyMacSigning({
      releaseRoot,
      plan,
      architecture,
      environment,
      runCommand,
    });
  }
  if (platform === 'win32') {
    return await verifyWindowsSigning({
      releaseRoot,
      plan,
      environment,
      runCommand,
    });
  }
  throw new Error(`Signing verification is unsupported on ${platform}.`);
}

async function verifyMacSigning({ releaseRoot, plan, architecture, environment, runCommand }) {
  const expectsSignature = present(environment.CSC_LINK);
  const expectsNotarization = allPresent(environment, [
    'APPLE_ID',
    'APPLE_APP_SPECIFIC_PASSWORD',
    'APPLE_TEAM_ID',
  ]);
  if (expectsNotarization && !expectsSignature) {
    throw new Error('macOS notarization credentials require a configured signing certificate.');
  }

  const bundleDirectory = architecture === 'x64' ? 'mac' : `mac-${architecture}`;
  const application = join(releaseRoot, bundleDirectory, 'Forgeboard.app');
  await requireDirectory(
    application,
    'Packaged Forgeboard.app is missing for signing verification.',
  );
  const display = await runCommand('codesign', ['--display', '--verbose=4', application]);
  const displayOutput = `${display.stdout}\n${display.stderr}`;
  const hasDeveloperId = display.exitCode === 0 && MAC_DEVELOPER_ID.test(displayOutput);

  if (!hasDeveloperId) {
    if (expectsSignature) {
      throw new Error(
        'A macOS signing certificate was configured, but Developer ID verification failed.',
      );
    }
    return unsignedSigningSummary('darwin');
  }

  const expectedTeamIdentifier = environment.APPLE_TEAM_ID?.trim();
  const actualTeamIdentifier = MAC_TEAM_IDENTIFIER.exec(displayOutput)?.[1]?.trim();
  if (
    expectedTeamIdentifier &&
    (!actualTeamIdentifier || actualTeamIdentifier !== expectedTeamIdentifier)
  ) {
    throw new Error(
      `The packaged macOS application was signed by Apple team ${actualTeamIdentifier ?? 'unknown'}, not configured team ${expectedTeamIdentifier}.`,
    );
  }

  const verification = await runCommand('codesign', [
    '--verify',
    '--deep',
    '--strict',
    '--verbose=2',
    application,
  ]);
  if (verification.exitCode !== 0) {
    throw new Error('The packaged macOS application has an invalid Developer ID signature.');
  }

  const dmgName = plan.artifacts.find((name) => name.endsWith('.dmg'));
  if (!dmgName) throw new Error('The macOS release plan has no DMG to validate.');
  const stapler = await runCommand('xcrun', ['stapler', 'validate', join(releaseRoot, dmgName)]);
  const notarized = stapler.exitCode === 0;
  if (expectsNotarization && !notarized) {
    throw new Error('macOS notarization was configured, but the DMG has no valid stapled ticket.');
  }
  return notarized
    ? {
        status: 'signed-and-notarized',
        message: 'Developer ID signature and stapled macOS notarization ticket verified.',
      }
    : {
        status: 'signed-not-notarized',
        message: 'Developer ID signature verified; no valid stapled notarization ticket was found.',
      };
}

async function verifyWindowsSigning({ releaseRoot, plan, environment, runCommand }) {
  const expectsSignature = present(environment.WIN_CSC_LINK) || present(environment.CSC_LINK);
  const installerName = plan.artifacts.find((name) => name.endsWith('.exe'));
  if (!installerName) throw new Error('The Windows release plan has no installer to validate.');
  const installer = join(releaseRoot, installerName);
  const result = await runCommand(
    'powershell.exe',
    ['-NoProfile', '-NonInteractive', '-Command', WINDOWS_SIGNATURE_SCRIPT],
    {
      ...environment,
      FORGEBOARD_ARTIFACT_TO_VERIFY: installer,
    },
  );
  if (result.exitCode !== 0) {
    throw new Error('Windows Authenticode inspection could not verify the packaged installer.');
  }
  let signature;
  try {
    signature = JSON.parse(result.stdout.trim());
  } catch {
    throw new Error('Windows Authenticode inspection returned invalid verification data.');
  }
  const valid = signature?.Status === 'Valid' && present(signature.Subject);
  if (!valid) {
    if (expectsSignature) {
      throw new Error(
        `A Windows signing certificate was configured, but Authenticode status was ${String(signature?.Status ?? 'unknown')}.`,
      );
    }
    return unsignedSigningSummary('win32');
  }
  return {
    status: 'signed',
    message: 'Windows Authenticode signature and signer certificate verified.',
  };
}

async function requireDirectory(path, message) {
  const directory = await stat(path).then(
    (value) => value.isDirectory(),
    () => false,
  );
  if (!directory) throw new Error(message);
}

function execute(executable, args, environment = process.env) {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, {
      env: environment,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => (stdout += chunk.toString()));
    child.stderr.on('data', (chunk) => (stderr += chunk.toString()));
    child.once('error', reject);
    child.once('close', (code) => resolve({ exitCode: code ?? -1, stdout, stderr }));
  });
}

function allPresent(environment, names) {
  return names.every((name) => present(environment[name]));
}

function present(value) {
  return typeof value === 'string' && value.trim() !== '';
}
