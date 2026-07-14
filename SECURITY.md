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
isolated Git worktrees. CWD isolation is explicitly not described as a sandbox. Docker profile
settings are visible but the Docker runner remains disabled while its implementation-checklist item
is open; Forgeboard does not misrepresent an ordinary child process as container isolation.

### Filesystem boundaries

All candidate paths are canonicalized, symlinks resolved, and containment checked against approved
roots immediately before access. Traversal, NUL bytes, device paths, credential patterns, ignored
files, and symlink escapes are denied. Sensitive overrides require a per-file high-friction approval.

### Git and agent overreach

Push, pull-request creation, merge, cherry-pick, rebase, destructive discard, reset, clean, force
push, worktree removal, and deletion of non-merged branches require impact-specific human approval.
Provider prompts are never auto-approved.

### Untrusted previews

The Electron shell denies unexpected navigation, new windows, permissions, and downloads. The
preview process service permits only loopback targets. Embedded preview content is not enabled until
the separate sandboxed browser surface and its protocol/host tests are complete.

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
runs verification on pull requests, and release signing is documented per platform. Adapter
manifests are validated in the process layer; the broader local-extension installation UI remains
unchecked and is not claimed as available.

## Supported versions

Security fixes target the latest released Forgeboard version while the project is pre-1.0.
