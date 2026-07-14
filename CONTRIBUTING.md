# Contributing

Forgeboard welcomes focused issues and pull requests. By contributing, you agree that your work is
licensed under the MIT license.

## Setup

```bash
corepack enable
pnpm install
pnpm verify
```

Changes that affect a trust boundary must include threat analysis and tests. New agent adapters and
node types must use validated manifests and documented extension points. Never add telemetry or a
Forgeboard-owned model proxy.

Use Conventional Commit-style subjects where practical. Keep pull requests reviewable, include test
evidence, and update `IMPLEMENTATION_CHECKLIST.md` only when the cited behavior is implemented and
verified.
