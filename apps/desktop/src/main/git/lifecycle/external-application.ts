import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { open, readdir, realpath, stat } from 'node:fs/promises';
import { basename, extname, isAbsolute, join, relative, resolve } from 'node:path';
import type { MessageBoxOptions } from 'electron';

import type { GitReviewTargetView } from '../../../shared/git/contracts.js';
import type { GitWorkspaceExternalOpenResult } from '../../../shared/git/lifecycle/contracts.js';
import { externalOpenConfirmation } from '../reviews/native-action-confirmations.js';
import { auditTargetMetadata } from '../targets/view-metadata.js';

export interface ExternalApplicationIdentity {
  readonly kind: 'executable' | 'macos-app-bundle';
  readonly configuredPath: string;
  readonly canonicalPath: string;
  readonly displayName: string;
  readonly identity: string;
}

export interface ExternalApplicationCaptureOptions {
  readonly platform?: NodeJS.Platform;
}

interface ExternalWorkspaceTarget<View> {
  readonly view: View;
  readonly repositoryRoot: string;
}

export interface ExternalWorkspaceOpenInput<View> {
  readonly target: ExternalWorkspaceTarget<View>;
  readonly configuredApplication: string;
  readonly confirm: (
    application: ExternalApplicationIdentity | null,
    workspacePath: string,
  ) => Promise<boolean>;
  readonly resolveCurrent: () => Promise<ExternalWorkspaceTarget<View>>;
  readonly sameTarget: (
    initial: ExternalWorkspaceTarget<View>,
    current: ExternalWorkspaceTarget<View>,
  ) => boolean;
  readonly getConfiguredApplication: () => string;
  readonly assertCurrent: () => void;
  readonly auditAllowed: (application: ExternalApplicationIdentity | null) => void;
  readonly openSystem: (workspacePath: string) => Promise<string>;
  readonly launchSelected: (
    application: ExternalApplicationIdentity,
    workspacePath: string,
  ) => Promise<void>;
}

export interface ExternalWorkspaceOpenOutcome<View> {
  readonly opened: boolean;
  readonly application: 'system-registered' | 'selected';
  readonly target: ExternalWorkspaceTarget<View>;
}

export interface GitWorkspaceExternalOpenInput {
  readonly target: ExternalWorkspaceTarget<GitReviewTargetView>;
  readonly branch: string | null;
  readonly configuredApplication: string;
  readonly confirm: (options: MessageBoxOptions) => Promise<boolean>;
  readonly resolveCurrent: () => Promise<ExternalWorkspaceTarget<GitReviewTargetView>>;
  readonly getConfiguredApplication: () => string;
  readonly assertCurrent: () => void;
  readonly appendAudit: (
    category: string,
    action: string,
    outcome: 'allowed' | 'denied' | 'failed',
    metadata: Record<string, unknown>,
  ) => void;
  readonly openSystem: (workspacePath: string) => Promise<string>;
  readonly launchSelected: (
    application: ExternalApplicationIdentity,
    workspacePath: string,
  ) => Promise<void>;
  readonly getBranch: (workspacePath: string) => Promise<string | null>;
}

/** Captures a selected executable without starting it, including enough identity to reject swaps. */
export async function captureExternalApplication(
  configuredPath: string,
  options: ExternalApplicationCaptureOptions = {},
): Promise<ExternalApplicationIdentity> {
  const canonicalPath = await realpath(resolve(configuredPath));
  const platform = options.platform ?? process.platform;
  const metadata = await stat(canonicalPath);
  if (metadata?.isDirectory()) {
    if (platform !== 'darwin' || extname(canonicalPath).toLowerCase() !== '.app') {
      throw new Error('The selected external application is not an executable file.');
    }
    return await captureMacApplicationBundle(configuredPath, canonicalPath, metadata);
  }
  const identity = await captureFileIdentity(canonicalPath, platform !== 'win32');
  return {
    kind: 'executable',
    configuredPath,
    canonicalPath,
    displayName: basename(canonicalPath),
    identity,
  };
}

export function sameExternalApplication(
  left: ExternalApplicationIdentity,
  right: ExternalApplicationIdentity,
): boolean {
  return (
    left.configuredPath === right.configuredPath &&
    left.canonicalPath === right.canonicalPath &&
    left.identity === right.identity
  );
}

/** Owns confirmation, identity revalidation, audit ordering, and the selected launch effect. */
export async function openWorkspaceExternal<View>(
  input: ExternalWorkspaceOpenInput<View>,
): Promise<ExternalWorkspaceOpenOutcome<View>> {
  const application = await selectedApplication(input.configuredApplication);
  if (!(await input.confirm(application, input.target.repositoryRoot))) {
    return {
      opened: false,
      application: applicationKind(application),
      target: input.target,
    };
  }
  input.assertCurrent();
  const current = await input.resolveCurrent();
  if (!input.sameTarget(input.target, current)) {
    throw new Error('The selected workspace changed after review. Open it again.');
  }
  const currentApplication = await selectedApplication(input.getConfiguredApplication());
  if (!sameOptionalApplication(application, currentApplication)) {
    throw new Error('The selected external application changed after review. Open it again.');
  }
  input.assertCurrent();
  input.auditAllowed(currentApplication);
  if (currentApplication === null) {
    const error = await input.openSystem(current.repositoryRoot);
    if (error !== '') throw new Error('The system could not open the selected workspace.');
  } else {
    await input.launchSelected(currentApplication, current.repositoryRoot);
  }
  return {
    opened: true,
    application: applicationKind(currentApplication),
    target: current,
  };
}

export async function openGitWorkspaceExternal(
  input: GitWorkspaceExternalOpenInput,
): Promise<GitWorkspaceExternalOpenResult> {
  const outcome = await openWorkspaceExternal({
    target: input.target,
    configuredApplication: input.configuredApplication,
    confirm: async (application, workspacePath) =>
      await input.confirm(
        externalOpenConfirmation(
          input.target.view,
          input.branch,
          application === null
            ? null
            : {
                kind: application.kind,
                applicationPath: application.canonicalPath,
                workspacePath,
              },
        ),
      ),
    resolveCurrent: input.resolveCurrent,
    sameTarget: (initial, current) =>
      current.repositoryRoot === initial.repositoryRoot &&
      JSON.stringify(current.view) === JSON.stringify(initial.view),
    getConfiguredApplication: input.getConfiguredApplication,
    assertCurrent: input.assertCurrent,
    auditAllowed: (application) =>
      input.appendAudit('git', 'open-workspace-external', 'allowed', {
        ...auditTargetMetadata(input.target.view),
        application: applicationKind(application),
        ...(application === null
          ? {}
          : {
              applicationFileName: application.displayName,
              selectionKind: application.kind,
            }),
      }),
    openSystem: input.openSystem,
    launchSelected: input.launchSelected,
  });
  if (!outcome.opened) {
    input.appendAudit('git', 'open-workspace-external', 'denied', {
      ...auditTargetMetadata(input.target.view),
      reason: 'native-confirmation-cancelled',
    });
  }
  return {
    opened: outcome.opened,
    targetKind: outcome.target.view.kind,
    branch: outcome.opened ? await input.getBranch(outcome.target.repositoryRoot) : input.branch,
    application: outcome.application,
  };
}

/** Starts the selected application directly: no shell, interpolation, or caller-controlled flags. */
export async function launchExternalApplication(
  application: ExternalApplicationIdentity,
  workspacePath: string,
): Promise<void> {
  const executable =
    application.kind === 'macos-app-bundle' ? '/usr/bin/open' : application.canonicalPath;
  const arguments_ =
    application.kind === 'macos-app-bundle'
      ? ['-a', application.canonicalPath, workspacePath]
      : [workspacePath];
  await new Promise<void>((resolveLaunch, rejectLaunch) => {
    const child = spawn(executable, arguments_, {
      detached: true,
      shell: false,
      stdio: 'ignore',
      windowsHide: true,
    });
    child.once('error', rejectLaunch);
    child.once('spawn', () => {
      child.unref();
      resolveLaunch();
    });
  });
}

async function captureMacApplicationBundle(
  configuredPath: string,
  canonicalPath: string,
  bundleMetadata: { readonly dev: number; readonly ino: number },
): Promise<ExternalApplicationIdentity> {
  const contentsRoot = await realpath(join(canonicalPath, 'Contents'));
  assertContained(canonicalPath, contentsRoot, 'The selected application bundle has unsafe links.');
  const infoPlistPath = await realpath(join(contentsRoot, 'Info.plist'));
  assertContained(contentsRoot, infoPlistPath, 'The application Info.plist leaves its bundle.');
  const executableRoot = await realpath(join(contentsRoot, 'MacOS'));
  assertContained(
    contentsRoot,
    executableRoot,
    'The application executable folder leaves its bundle.',
  );
  const executableIdentities: string[] = [];
  let executableCount = 0;
  for (const name of (await readdir(executableRoot)).sort()) {
    const executablePath = await realpath(join(executableRoot, name));
    assertContained(
      executableRoot,
      executablePath,
      'A selected application executable leaves its bundle.',
    );
    const metadata = await stat(executablePath);
    if (!metadata.isFile()) continue;
    if ((metadata.mode & 0o111) !== 0) executableCount += 1;
    executableIdentities.push(`${name}:${await captureFileIdentity(executablePath, false)}`);
  }
  if (executableCount === 0) {
    throw new Error('The selected application bundle contains no executable program.');
  }
  const plistIdentity = await captureFileIdentity(infoPlistPath, false);
  return {
    kind: 'macos-app-bundle',
    configuredPath,
    canonicalPath,
    displayName: basename(canonicalPath),
    identity: [bundleMetadata.dev, bundleMetadata.ino, plistIdentity, ...executableIdentities].join(
      ':',
    ),
  };
}

async function captureFileIdentity(path: string, requireExecutable: boolean): Promise<string> {
  const file = await open(path, 'r');
  try {
    const metadata = await file.stat();
    if (!metadata.isFile()) throw new Error('The selected external application is not a file.');
    if (requireExecutable && (metadata.mode & 0o111) === 0) {
      throw new Error('The selected external application is not executable.');
    }
    const digest = createHash('sha256');
    const contents = file.createReadStream({ autoClose: false }) as AsyncIterable<Buffer>;
    for await (const chunk of contents) digest.update(chunk);
    return [metadata.dev, metadata.ino, metadata.size, digest.digest('hex')].join(':');
  } finally {
    await file.close();
  }
}

function assertContained(root: string, candidate: string, message: string): void {
  const path = relative(root, candidate);
  if (
    path === '' ||
    (path !== '..' && !path.startsWith('../') && !path.startsWith('..\\') && !isAbsolute(path))
  ) {
    return;
  }
  throw new Error(message);
}

async function selectedApplication(path: string): Promise<ExternalApplicationIdentity | null> {
  return path === '' ? null : await captureExternalApplication(path);
}

function sameOptionalApplication(
  left: ExternalApplicationIdentity | null,
  right: ExternalApplicationIdentity | null,
): boolean {
  return left === null || right === null ? left === right : sameExternalApplication(left, right);
}

function applicationKind(
  application: ExternalApplicationIdentity | null,
): 'system-registered' | 'selected' {
  return application === null ? 'system-registered' : 'selected';
}
