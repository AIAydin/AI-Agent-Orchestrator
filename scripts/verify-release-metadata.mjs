import process from 'node:process';

import {
  loadReleaseMetadata,
  validateReleaseMetadata,
  validateReleaseTag,
} from './release-metadata.mjs';

const args = new Set(process.argv.slice(2));
for (const argument of args) {
  if (argument !== '--verify-tag') throw new Error(`Unknown argument: ${argument}`);
}

const metadata = await loadReleaseMetadata();
const manifest = validateReleaseMetadata(metadata);
if (args.has('--verify-tag')) {
  const tag = process.env.GITHUB_REF_NAME;
  if (!tag) throw new Error('GITHUB_REF_NAME is required for release-tag verification.');
  validateReleaseTag(tag, metadata.rootPackage, metadata.desktopPackage);
}

process.stdout.write(
  `Release metadata verified: Dugite ${manifest.dugite.packageVersion}, Git ${manifest.dugite.gitVersion}, ${manifest.archives.length} source archives.\n`,
);
