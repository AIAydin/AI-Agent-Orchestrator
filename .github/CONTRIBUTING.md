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

Keep work grouped in named feature or domain subfolders. No hand-written source, test, style, script,
workflow, or configuration file may exceed 2,000 lines. Maintained folders under apps, packages,
scripts, config, docs, and .github may contain no more than 12 direct hand-written files of any type;
the repository root may contain only its allowlisted standard entry files. `pnpm check:structure`
enforces all three limits in CI.

Use Conventional Commit-style subjects where practical. Keep pull requests reviewable, include test
evidence, and update `IMPLEMENTATION_CHECKLIST.md` only when the cited behavior is implemented and
verified.
