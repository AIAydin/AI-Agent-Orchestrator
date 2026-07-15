export const PRODUCT = Object.freeze({
  name: 'Forgeboard',
  slug: 'forgeboard',
  protocol: 'forgeboard',
  appId: 'dev.forgeboard.desktop',
  dataDirectoryName: 'Forgeboard',
  worktreeDirectoryName: 'worktrees',
  description: 'A local-first visual workshop for software-building agents.',
} as const);

export type ProductIdentity = typeof PRODUCT;
