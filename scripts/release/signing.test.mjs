import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { platformReleasePlan } from './artifacts.mjs';
import { verifyPlatformSigning } from './signing.mjs';

const VERSION = '0.1.0';
const EMPTY_RESULT = { exitCode: 0, stdout: '', stderr: '' };

test('Linux records signing as not applicable without running a verifier', async () => {
  const runCommand = () => assert.fail('Linux must not invoke a platform signing command.');
  const summary = await verifyPlatformSigning({
    releaseRoot: '/unused',
    plan: platformReleasePlan(VERSION, 'linux', 'x64'),
    platform: 'linux',
    architecture: 'x64',
    environment: {},
    runCommand,
  });
  assert.equal(summary.status, 'not-applicable');
});

test('macOS keeps a verified ad-hoc build on the explicit unsigned path', async () => {
  await withMacRelease('arm64', async (releaseRoot, plan) => {
    const calls = [];
    const summary = await verifyPlatformSigning({
      releaseRoot,
      plan,
      platform: 'darwin',
      architecture: 'arm64',
      environment: {},
      runCommand: async (...call) => {
        calls.push(call);
        return {
          exitCode: 0,
          stdout: '',
          stderr: 'Signature=adhoc\nTeamIdentifier=not set',
        };
      },
    });
    assert.equal(summary.status, 'unsigned-development');
    assert.equal(calls.length, 1);
    assert.equal(calls[0][0], 'codesign');
  });
});

test('macOS fails closed when configured signing does not yield Developer ID proof', async () => {
  await withMacRelease('x64', async (releaseRoot, plan) => {
    await assert.rejects(
      verifyPlatformSigning({
        releaseRoot,
        plan,
        platform: 'darwin',
        architecture: 'x64',
        environment: { CSC_LINK: 'certificate' },
        runCommand: async () => ({
          exitCode: 0,
          stdout: '',
          stderr: 'Signature=adhoc\nTeamIdentifier=not set',
        }),
      }),
      /Developer ID verification failed/u,
    );
  });
});

test('macOS status comes from Developer ID and stapled-ticket verification', async () => {
  await withMacRelease('arm64', async (releaseRoot, plan) => {
    const responses = [
      {
        exitCode: 0,
        stdout: '',
        stderr: 'Authority=Developer ID Application: Forgeboard (TEAMID)\nTeamIdentifier=TEAMID',
      },
      EMPTY_RESULT,
      { exitCode: 0, stdout: 'The validate action worked!', stderr: '' },
    ];
    const summary = await verifyPlatformSigning({
      releaseRoot,
      plan,
      platform: 'darwin',
      architecture: 'arm64',
      environment: {
        CSC_LINK: 'certificate',
        APPLE_ID: 'maintainer@example.invalid',
        APPLE_APP_SPECIFIC_PASSWORD: 'secret',
        APPLE_TEAM_ID: 'TEAMID',
      },
      runCommand: async () => responses.shift(),
    });
    assert.equal(summary.status, 'signed-and-notarized');
    assert.equal(responses.length, 0);
  });
});

test('macOS fails closed when the verified Developer ID belongs to another Apple team', async () => {
  await withMacRelease('arm64', async (releaseRoot, plan) => {
    await assert.rejects(
      verifyPlatformSigning({
        releaseRoot,
        plan,
        platform: 'darwin',
        architecture: 'arm64',
        environment: {
          CSC_LINK: 'certificate',
          APPLE_ID: 'maintainer@example.invalid',
          APPLE_APP_SPECIFIC_PASSWORD: 'secret',
          APPLE_TEAM_ID: 'EXPECTEDTEAM',
        },
        runCommand: async () => ({
          exitCode: 0,
          stdout: '',
          stderr:
            'Authority=Developer ID Application: Another Publisher (OTHERTEAM)\nTeamIdentifier=OTHERTEAM',
        }),
      }),
      /signed by Apple team OTHERTEAM, not configured team EXPECTEDTEAM/u,
    );
  });
});

test('macOS fails when notarization was expected but no ticket verifies', async () => {
  await withMacRelease('arm64', async (releaseRoot, plan) => {
    const responses = [
      {
        exitCode: 0,
        stdout: '',
        stderr: 'Authority=Developer ID Application: Forgeboard (TEAMID)\nTeamIdentifier=TEAMID',
      },
      EMPTY_RESULT,
      { exitCode: 1, stdout: '', stderr: 'ticket missing' },
    ];
    await assert.rejects(
      verifyPlatformSigning({
        releaseRoot,
        plan,
        platform: 'darwin',
        architecture: 'arm64',
        environment: {
          CSC_LINK: 'certificate',
          APPLE_ID: 'maintainer@example.invalid',
          APPLE_APP_SPECIFIC_PASSWORD: 'secret',
          APPLE_TEAM_ID: 'TEAMID',
        },
        runCommand: async () => responses.shift(),
      }),
      /no valid stapled ticket/u,
    );
  });
});

test('Windows derives signed status from valid Authenticode evidence', async () => {
  const plan = platformReleasePlan(VERSION, 'win32', 'x64');
  let command;
  const summary = await verifyPlatformSigning({
    releaseRoot: 'C:\\release',
    plan,
    platform: 'win32',
    architecture: 'x64',
    environment: { WIN_CSC_LINK: 'certificate' },
    runCommand: async (...call) => {
      command = call;
      return {
        exitCode: 0,
        stdout: JSON.stringify({ Status: 'Valid', Subject: 'CN=Forgeboard' }),
        stderr: '',
      };
    },
  });
  assert.equal(summary.status, 'signed');
  assert.equal(command[0], 'powershell.exe');
  assert.match(command[2].FORGEBOARD_ARTIFACT_TO_VERIFY, /windows-x64-setup\.exe$/u);
});

test('Windows unsigned builds stay green but configured invalid signatures fail closed', async () => {
  const plan = platformReleasePlan(VERSION, 'win32', 'x64');
  const runCommand = async () => ({
    exitCode: 0,
    stdout: JSON.stringify({ Status: 'NotSigned', Subject: null }),
    stderr: '',
  });
  const unsigned = await verifyPlatformSigning({
    releaseRoot: 'C:\\release',
    plan,
    platform: 'win32',
    architecture: 'x64',
    environment: {},
    runCommand,
  });
  assert.equal(unsigned.status, 'unsigned-development');
  await assert.rejects(
    verifyPlatformSigning({
      releaseRoot: 'C:\\release',
      plan,
      platform: 'win32',
      architecture: 'x64',
      environment: { WIN_CSC_LINK: 'certificate' },
      runCommand,
    }),
    /Authenticode status was NotSigned/u,
  );
});

async function withMacRelease(architecture, callback) {
  const root = await mkdtemp(join(tmpdir(), 'forgeboard-signing-test-'));
  try {
    const bundleDirectory = architecture === 'x64' ? 'mac' : `mac-${architecture}`;
    await mkdir(join(root, bundleDirectory, 'Forgeboard.app'), {
      recursive: true,
    });
    await callback(root, platformReleasePlan(VERSION, 'darwin', architecture));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}
