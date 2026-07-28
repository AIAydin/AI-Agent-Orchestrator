import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

import { verifyCompleteReleaseSet } from './artifacts.mjs';

const RELEASE_TARGETS = [
  ['darwin', 'arm64'],
  ['darwin', 'x64'],
  ['linux', 'x64'],
  ['win32', 'x64'],
];

export function createPublicationSummary(releaseInfo, preparedNotes) {
  if (!Array.isArray(releaseInfo) || releaseInfo.length !== RELEASE_TARGETS.length) {
    throw new Error('Publication requires one verified metadata record for every release target.');
  }
  const versions = new Set(releaseInfo.map((info) => info.version));
  if (versions.size !== 1) throw new Error('Publication metadata contains inconsistent versions.');
  const version = releaseInfo[0]?.version;
  if (typeof version !== 'string' || !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/u.test(version)) {
    throw new Error('Publication metadata contains an invalid version.');
  }

  const desktop = releaseInfo.filter((info) => info.platform !== 'linux');
  const unsigned = desktop.some((info) => info.signing.status === 'unsigned-development');
  const macNotNotarized = desktop.some((info) => info.signing.status === 'signed-not-notarized');
  const label = unsigned
    ? 'unsigned development; Linux checksum-only'
    : macNotNotarized
      ? 'macOS signed, not notarized; Windows signed; Linux checksum-only'
      : 'macOS signed and notarized; Windows signed; Linux checksum-only';
  const warning = unsigned
    ? 'Unsigned development release. macOS Gatekeeper or Windows SmartScreen may show normal provenance warnings. Verify the published checksums and source before using an operating-system per-app approval.'
    : macNotNotarized
      ? 'Signed development release. The macOS artifacts have a verified Developer ID signature but no stapled notarization ticket.'
      : 'macOS Developer ID signatures and notarization tickets and the Windows Authenticode signature were verified after packaging. Linux packages are checksum-verified and not platform-code-signed.';
  const signingLines = releaseInfo
    .map(
      (info) =>
        `- ${displayTarget(info.platform, info.architecture)}: \`${info.signing.status}\` — ${canonicalSigningMessage(info.signing.status)}`,
    )
    .join('\n');
  const notes = String(preparedNotes ?? '').trim();
  if (!notes) throw new Error('Prepared release notes are required for publication.');

  return {
    title: `Artemis v${version} (${label})`,
    notes: `> [!WARNING]\n> ${warning}\n\n## Verified signing status\n\n${signingLines}\n\n${notes}\n`,
  };
}

export async function writePublicationFiles(
  releaseRoot,
  preparedNotesPath,
  outputRoot,
  expectedSourceCommit,
) {
  const root = resolve(releaseRoot);
  const records = await readReleaseInfo(root);
  const verified = await verifyCompleteReleaseSet(root, records[0].version);
  if (!/^[a-f0-9]{40}$/u.test(expectedSourceCommit ?? '')) {
    throw new Error('Publication requires the expected 40-character source commit.');
  }
  if (verified.sourceCommit !== expectedSourceCommit) {
    throw new Error(
      `Release artifacts were built from ${verified.sourceCommit}, not expected commit ${expectedSourceCommit}.`,
    );
  }
  const preparedNotes = await readFile(resolve(preparedNotesPath), 'utf8');
  const summary = createPublicationSummary(records, preparedNotes);
  const destination = resolve(outputRoot);
  await mkdir(destination, { recursive: true });
  await Promise.all([
    writeFile(join(destination, 'title.txt'), `${summary.title}\n`),
    writeFile(join(destination, 'notes.md'), summary.notes),
  ]);
  return summary;
}

async function readReleaseInfo(root) {
  return await Promise.all(
    RELEASE_TARGETS.map(async ([platform, architecture]) => {
      const path = join(root, `RELEASE-INFO-${platform}-${architecture}.json`);
      return JSON.parse(await readFile(path, 'utf8'));
    }),
  );
}

function displayTarget(platform, architecture) {
  if (platform === 'darwin') return `macOS ${architecture}`;
  if (platform === 'win32') return `Windows ${architecture}`;
  return `Linux ${architecture}`;
}

function canonicalSigningMessage(status) {
  const messages = {
    'unsigned-development': 'No trusted desktop distribution signature was verified.',
    'signed-not-notarized':
      'A Developer ID signature was verified, but no stapled notarization ticket was found.',
    'signed-and-notarized':
      'A Developer ID signature and stapled macOS notarization ticket were verified.',
    signed: 'A valid Windows Authenticode signature was verified.',
    'not-applicable': 'Checksums were verified; platform code signing does not apply.',
  };
  const message = messages[status];
  if (!message) throw new Error(`Unsupported publication signing status ${String(status)}.`);
  return message;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [releaseRoot, preparedNotesPath, outputRoot, expectedSourceCommit] = process.argv.slice(2);
  if (
    !releaseRoot ||
    !preparedNotesPath ||
    !outputRoot ||
    !expectedSourceCommit ||
    process.argv.length !== 6
  ) {
    throw new Error(
      'Usage: node scripts/release/publication.mjs <release-directory> <prepared-notes> <output-directory> <source-commit>',
    );
  }
  const summary = await writePublicationFiles(
    releaseRoot,
    preparedNotesPath,
    outputRoot,
    expectedSourceCommit,
  );
  process.stdout.write(`Prepared ${summary.title}.\n`);
}
