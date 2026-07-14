# Security policy and threat model

## Reporting a vulnerability

Please do not open a public issue for a suspected vulnerability. Until a dedicated security contact
is configured, use GitHub's private vulnerability reporting for this repository. Include impact,
reproduction steps, affected versions, and any suggested mitigation.

## Security posture

Forgeboard treats repositories, files, imported canvases, terminal output, agent messages, rendered
Markdown/SVG, collaboration clients, and preview pages as untrusted. No repository instruction is
authority to execute a command or broaden permissions.

### Malicious repositories and prompt injection

Ignored and sensitive files are not attached automatically. Context is explicit and previewed before
launch. Repository text cannot approve operations or alter policy. Rich Markdown/SVG rendering is
kept disabled until its sanitizer and tests are complete.

### Terminal and agent execution

Commands use executable-plus-argument arrays without shell interpolation. Writable agents default to
isolated Git worktrees. CWD isolation is explicitly not described as a sandbox. An optional Docker
profile runs a configured in-image agent as a non-root user with one assigned-worktree mount,
resource limits, a read-only container filesystem, default seccomp, dropped capabilities, and
network disabled unless the user explicitly enables it. Forgeboard adds no host credential stores,
keychains, SSH agents, Docker socket, or extra host mounts to the container.

Docker images are never pulled automatically. The main process checks the local daemon, image
metadata, declared volumes, Linux compatibility, and exact in-image agent executable. Pulling is a
separate UI action followed by a BrowserWindow-parented native confirmation. The pull uses a bounded
argument array and output/timeout limits, then readiness is checked again with a disposable,
no-network, no-mount `--version` probe. A Docker launch also rechecks readiness immediately before
use and always passes `--pull never`.

### Filesystem boundaries

All candidate paths are canonicalized, symlinks resolved, and containment checked against approved
roots immediately before access. Traversal, NUL bytes, device paths, credential patterns, ignored
files, and symlink escapes are denied. Sensitive overrides require a per-file high-friction approval.

### Git and agent overreach

Push, pull-request creation, merge, cherry-pick, rebase, destructive discard, reset, clean, force
push, worktree removal, and deletion of non-merged branches require impact-specific human approval.
Provider prompts are never auto-approved.

### Untrusted previews

The Electron shell denies unexpected top-level navigation, new windows, permissions, downloads, and
non-loopback renderer traffic. Preview nodes accept only runtime-owned loopback ports and validated
hosts, then render the page in a sandboxed frame without Node or Forgeboard preload access. Preview
content cannot open a system-browser URL implicitly. Native development commands are still ordinary
user processes; Docker is required for hard network/filesystem isolation.

### Local extensions

Local extensions are untrusted data. Versioned strict schemas permit only declarative canvas fields,
ports, built-in visual tokens, and existing validated CLI adapter manifests. There is no extension
entrypoint and no renderer JavaScript, HTML, SVG, CSS, preload, or Node/Electron module loading. The
trusted process canonicalizes the user-selected folder, rejects symlink and traversal escapes,
bounds resources, and requires an exact digest-bound permission confirmation in a main-owned
system dialog before install or update. It stages a trusted ledger record before mutation and
activates only after success. Discovery revalidates installed snapshots, requires an exact active
ledger match, and quarantines missing, pending, revoked, mismatched, or corrupt entries instead of
loading them. Canvas controls and local-reference pickers are Forgeboard-owned; persisted values are
bounded and revalidated. Actual CLI runs resolve active manifests again immediately before launch
and retain their separate launch disclosure and approval. See
[`docs/EXTENSIONS.md`](docs/EXTENSIONS.md).

### Secrets

`.env*`, private keys, certificates, common credential files, OS keychains, CLI auth stores, ignored
files, and configured secret patterns are excluded by default. SQLite never stores tokens.
Forgeboard currently delegates authentication to local CLIs and therefore does not handle tokens; a
future integration that must handle one cannot ship until an operating-system vault is wired.

### Collaboration authorization

The optional server enforces room roles, signed expiring invites, revocation, origin limits, rate
limits, and an audit trail. Collaboration schemas cannot carry source, prompts, diffs, transcripts,
terminal output, or environment values.

### Supply chain

Dependencies and the lockfile are committed, automated updates are scoped through Dependabot, CI
runs verification on pull requests, and release signing is documented per platform. Adapter and
local-extension manifests are validated in the process layer. The Settings installation surface
uses native selection, owner-bound expiring plans, validated IPC responses, digest-bound approval,
and audited mutations; it never loads extension code into the renderer.

## Supported versions

Security fixes target the latest released Forgeboard version while the project is pre-1.0.
