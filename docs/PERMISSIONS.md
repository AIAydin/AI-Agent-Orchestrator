# Permission profiles

Forgeboard permission profiles are configured in **Settings → Permissions** or during first-run
setup. Agent nodes can then choose a profile from the inspector. Normal use does not require
editing source files, JSON, environment files, or adapter manifests; settings export/import is an
optional portability feature.

## Selected-agent readiness is a setup gate

The first-run agent step cannot continue until the currently selected CLI has ready evidence from
Electron main. Forgeboard resolves the bundled executable, detected command, UI-selected override,
or complete custom-CLI draft, then runs only that candidate's bounded version and capability probes.
An invalid custom configuration, missing executable, failed probe, adapter mismatch, or unrecognized
version keeps **Continue** disabled and shows an actionable reason. A successful result includes the
validated executable and version.

Readiness is not launch approval. Checking a draft override does not persist it, and completing setup
does not let the renderer start that executable. Every later agent run still uses the exact
cancel-default launch review described below.

Every agent run has a cancel-default review step. The review shows the exact top-level executable,
arguments, working directory, inherited environment-variable names, selected context, context
hashes, effective permission profile, and known limitations. Cancelling releases the prepared run
without starting the agent.

## Built-in profiles

### Plan / read-only

Forgeboard asks a supported provider to use its plan/read-only mode in the primary checkout. This
is a provider control, not an operating-system sandbox. A generic process can still have the
current desktop user's filesystem and network privileges.

### Worktree write

Forgeboard creates a dedicated managed Git worktree and asks the provider to confine writes to it.
Changes remain outside the primary checkout until reviewed. A working directory alone does not
prevent a host process or its descendants from accessing other locations allowed to the desktop
user.

### Docker isolated

Forgeboard runs a configured in-image agent as a non-root user with one assigned-worktree bind,
`--pull never`, a read-only container filesystem, dropped capabilities, no-new-privileges,
resource limits, and no host credential mounts. Network access is disabled unless explicitly
enabled in the UI.

Clicking **Review & run** invokes the selected Docker client for bounded daemon and image-metadata
preflight. It does not run the in-image agent. Forgeboard binds the reviewed launch to a strict
immutable `sha256:` image ID, rechecks the Docker client identity and tag binding after approval,
and then starts the exact disclosed agent command once. The separate **Check Docker** action in
Settings may run a constrained, no-network, no-host-mount `--version` readiness probe.

## Custom profile

Custom is one reusable, fully UI-configured policy with either a Host or Docker runtime.

The editor controls:

- whole-worktree read-only, whole-worktree read/write, or host-only explicit relative roots;
- ignored and sensitive worktree-content visibility;
- the selected top-level agent executable or an exact executable allowlist;
- advisory requests about development servers and tests;
- Docker network, CPU, and memory limits; and
- the always-on requirement to review changes before they reach the primary branch.

### Custom Host

Every Custom Host run receives a managed worktree. Forgeboard canonicalizes configured roots,
rejects traversal, symlink aliases, non-folder roots, and context outside readable roots, and binds
the selected top-level executable's identity and content immediately before launch.

Host roots, ignored/sensitive visibility, network behavior, and development-server/test choices
are disclosed policy and agent instructions. They do not create an operating-system sandbox or
technically constrain descendant processes. The approval screen repeats those limitations for
every run.

### Custom Docker

Docker can technically enforce only a whole assigned-worktree read-only or read/write bind, so
explicit subdirectory roots are unavailable. A whole-worktree bind cannot hide individual ignored
or sensitive files that are present in that worktree; both visibility choices therefore require
an explicit **Allow** before the profile can be saved. Allowing visibility does not attach any file
as agent context.

The exact in-container entrypoint is disclosed separately from the outer Docker client. The launch
uses the Custom network and resource limits shown in the approval dialog and never mounts host CLI
credentials.

## Remembered project-check approvals

Remembered approvals are deliberately limited to project checks. After reviewing a lint, typecheck,
test, build, or custom check, the native confirmation can optionally remember that exact check for
30 days. Electron main creates and later selects the grant; the renderer never supplies the approval
identity that authorizes execution.

The SHA-256 resource fingerprint binds all of the following:

- project, stored check identity, label, and check kind;
- resolved executable, literal argument array, and canonical working directory;
- inherited environment-variable names, but not their values;
- repository-root filesystem identity; and
- executable/shim identities and relevant package-script content.

The grant also carries its project and `command-execute` action scope. Any command, path, executable,
package-script, or identity drift stops the match and restores the native confirmation. The current
UI creates reusable check records only for the fixed 30-day window; it does not expose general grant
creation.

**Settings → Permissions → Scoped approvals** lists active and inactive local records and revokes an
active grant immediately. This list is live security state, not part of the unsaved Settings draft.
Saved approvals are device-local and are not a general permission-profile setting.

## Per-use actions and outbound approval

A remembered check never authorizes an agent launch, a context attachment or sensitive-file
override, a Docker pull, a Git clone, another external send, or a destructive Git action. Those
implemented operations retain their own per-use review or confirmation.

Git clone and Docker image pull pass through a main-owned outbound gate. The cancel-default native
dialog displays the exact action, transport, credential-free endpoint/resource, and local or Docker
details. The plan is bound to the originating window, expires after a short interval, and is consumed
once. After approval, Forgeboard rebuilds and fingerprints the disclosure; changed destinations or
actions fail closed. Only the gate can mint the opaque permit accepted by the low-level clone and
pull executors.

## Context is separately approved

Permission to read visible worktree content is not permission to attach it to a provider prompt.
Forgeboard context uses explicit File nodes and resolver-supplied manifest evidence. Each
attachment carries its own SHA-256 digest; the source file, managed-worktree copy, and approved
digest must match. Forgeboard rehashes attachments immediately before spawn. Ignored or sensitive
files still require the existing exact per-file, high-friction override.

## Choosing a safe profile

- Use **Plan / read-only** for provider-supported planning against the current checkout.
- Use **Worktree write** for ordinary coding work that should remain reviewable and separate from
  the primary checkout.
- Use **Docker isolated** when a technical filesystem/network boundary is required and a suitable
  local image is available.
- Use **Custom Host** for narrower, honestly disclosed policy over a managed worktree.
- Use **Custom Docker** for a tailored whole-worktree container boundary and resource policy.

If a saved profile is unavailable for the selected agent, Forgeboard preserves the configured
choice, explains why it cannot run, and disables **Review & run**. It does not silently substitute
a broader or different permission profile.
