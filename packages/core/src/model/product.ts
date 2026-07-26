export const PRODUCT = Object.freeze({
  name: 'Artemis',
  // Technical identity stays 'forgeboard' so existing installs keep their
  // protocol handler, OS app id, and on-disk data directories.
  slug: 'forgeboard',
  protocol: 'forgeboard',
  appId: 'dev.forgeboard.desktop',
  dataDirectoryName: 'Forgeboard',
  worktreeDirectoryName: 'worktrees',
  description: 'A local-first visual workshop for software-building agents.',
} as const);

export type ProductIdentity = typeof PRODUCT;
