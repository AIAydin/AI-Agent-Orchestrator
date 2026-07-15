# Permission profiles

Forgeboard permission profiles are configured in **Settings → Permissions** or during first-run
setup. Agent nodes can then choose a profile from the inspector. Normal use does not require
editing source files, JSON, environment files, or adapter manifests; settings export/import is an
optional portability feature.

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
