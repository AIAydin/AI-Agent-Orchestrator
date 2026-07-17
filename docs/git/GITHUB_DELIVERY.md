# Remote Git and GitHub delivery

Forgeboard can push a completed managed agent run and, when the optional GitHub CLI is available,
inspect GitHub, create a pull request from a revalidated pushed-commit snapshot, and read CI for the
exact selected commit. Once the existing
remote and optional GitHub CLI prerequisites below are available, delivery choices and actions are
configured in the desktop UI. They do not require source edits, environment files, JSON, or
hand-written manifests.

## What you need

- A project with an existing credential-free local filesystem, HTTPS, or SSH Git remote. Projects
  cloned in Forgeboard normally have an `origin` remote. Local filesystem remotes can be used for
  push testing and local delivery.
- A completed writable Agent run with committed changes in its Forgeboard-managed worktree.
- One or more project checks configured under **Settings → Commands & checks**.
- For GitHub repository, pull-request, and CI actions only: the optional `gh` executable installed
  on `PATH` and authenticated for the selected GitHub or GitHub Enterprise host. Forgeboard reports
  missing or unauthenticated CLI state in the node and never asks for or stores a GitHub token.
  The `gh` installation found on the desktop process `PATH` is a trusted local executable.
  Forgeboard resolves and pins its absolute real path for the session, disables CLI telemetry and
  update checks for its child process, and rejects configured HTTP Unix-socket routing before API
  actions.

Choose the default remote name under **Settings → Git & previews → Remote automation**. A Git / PR
node can override that name for its own saved configuration. Forgeboard resolves the name from the
selected repository. Main captures the one exact effective push URL while the renderer remains free
of filesystem paths and exact Git remote/push URLs. Validated PR and CI result URLs cross the typed
boundary only so the UI can display or copy them. Adding or editing remote URLs is not yet a UI
feature.

## Push a reviewed run

1. Finish a writable Agent run and commit its intended changes from Git review.
2. Add or select a **Git / PR** node.
3. Choose the completed terminal Agent run, remote, destination branch, and pull-request base.
4. Select **Inspect exact Git state**. Review the source branch and HEAD, recorded run base,
   divergence, commits, changed files, remote disclosure, and readiness blockers.
5. Select **Open readiness checks & approval**. Choose the required configured checks, run all of
   them, review their exact results, and record human quality approval.
6. Return to the Git / PR node, refresh the exact state, and select **Review push**.
7. Review the immutable UI plan, then continue to the operating-system confirmation. That native
   dialog defaults to **Cancel** and names the exact destination, source and destination branches,
   commit range, commits, files, change counts, and readiness evidence.

Forgeboard pushes the approved source object ID to the full destination branch ref with ordinary
non-force semantics. The command contains exactly one source-object-to-destination-branch refspec;
it does not implicitly send tags or any other ref. Execution uses the exact approved URL literal
instead of the remote name, converts a local destination to an absolute path, and enables only that
destination's file, HTTPS, or SSH protocol. Forgeboard never offers force push. A non-fast-forward
remote rejects the push without being overwritten.

## Create a GitHub pull request

1. After the exact branch is pushed, select **Check GitHub auth & repository** and approve the
   on-demand native read confirmation.
2. Forgeboard verifies the authenticated host and repository, remote base commit, and that the
   remote destination branch equals the exact reviewed source HEAD.
3. Enter the pull-request title and body in the node and choose draft mode if desired.
4. Select **Review pull request**, review the point-in-time plan, and continue to the native
   confirmation. The native disclosure includes the exact title and body as well as their digest,
   the repository, branches, remote commits, local commits/files, and readiness evidence.
5. After creation, Forgeboard shows the validated URL. Use **Copy pull request URL** to place it on
   the clipboard; Forgeboard does not permit arbitrary renderer navigation.

The pull-request body is sent to `gh` through standard input, not a shell or command-line argument.
The URL returned by `gh` is accepted only when it is HTTPS, contains no credentials/query/fragment,
and identifies the approved host, owner, repository, and pull-request number.
Forgeboard revalidates the reviewed remote head immediately before the create request, but GitHub
pull requests follow a branch name rather than an immutable commit ID. Concurrent movement can race
that request, and later movement of the branch can change the pull request's contents; the UI does
not claim atomic or permanently SHA-bound creation.

## Read exact-head CI

Select **Check CI for exact HEAD** after a successful GitHub status check. The action is explicit and
never polled. Forgeboard asks `gh` for at most 20 recent runs, validates every result URL, and shows
only runs whose branch and full head SHA match the exact selected source. A zero-run result means no
matching current CI was returned; it is not displayed as a passing check.

## Security boundary

- Electron main resolves the saved project, run, owned managed worktree, canonical repository,
  branch, object IDs, remotes, commits, files, checks, and approval. Renderer-provided paths, URLs,
  commands, object IDs, force flags, and approval evidence are rejected by the shared contracts.
- An actionable push or pull request requires a clean committed source, complete bounded impact,
  all selected deterministic checks passing, and current human approval for the same exact source
  and command evidence. AI or reviewer outcomes cannot replace the human decision.
- The source, remote identity, branches, readiness, and disclosure are revalidated before the
  native dialog, after it, and immediately before Git or `gh` can contact the destination. Plans are
  owner-bound, expiring, single-use, and cleared on window loss, import/reset, privacy deletion, or
  shutdown.
- Network Git remotes must use credential-free HTTPS or SSH transport. Plain HTTP and Git protocol
  remotes, embedded credentials, URL query values, fragments, unsupported helpers, and ambiguous
  remote identities fail closed. Repository- and worktree-scope `credential.*`, `http.*`, and URL
  rewrite configuration is rejected for Forgeboard pushes. Matching active URL rewrites from any
  scope are also rejected immediately before execution so they cannot retarget the approved
  literal.
- Global and system Git credential and network configuration remain a user-owned trust boundary.
  This includes credential helpers, headers, cookies, client certificates, proxies, and TLS
  settings, plus the user's SSH configuration, proxy commands, and agent. Those facilities may
  execute helpers or contact configured intermediaries; Forgeboard does not make a categorical
  no-redirect guarantee across that trusted stack. GitHub actions may use `gh`'s existing
  authenticated session; Forgeboard stores neither credential.
- A local filesystem remote's exact path stays in main and appears only in the native confirmation.
  The renderer receives the fixed label **Local Git repository**. The destination repository's
  receive hooks and Git configuration can execute as the operating-system user during a push, so a
  local destination must be trusted.
- Before Forgeboard contacts the push destination, it verifies the complete approved source object
  closure with lazy fetching disabled. A partial clone missing an object therefore fails closed
  before destination contact instead of fetching from a promisor remote implicitly.
- Forgeboard blocks its own push from a shallow repository or a history containing Git LFS pointer
  content, because it cannot prove complete history or separately disclose and approve the LFS
  object upload. These push-only guards do not categorically block exact inspection, or PR/CI
  actions for an exact branch that was already pushed through another trusted workflow.
- Executable or redirected source `pre-push` hooks and configured source hook paths block
  Forgeboard's push. They are not a prerequisite for exact inspection, PR creation, or CI reads of
  an already-pushed branch. Destination-side receive hooks remain part of the destination's trust
  boundary.
- Audit rows contain bounded action metadata and digests, not the pull-request body, repository
  file contents, local worktree paths, tokens, or credential-bearing URLs.

## Deliberate limits

Actionable plans support at most 256 commits, 256 changed files, and 65,536 total disclosed path
characters. Pull-request bodies support at most 32,768 characters. A repository can expose at most
32 remotes to this surface. Forgeboard refuses oversized or truncated impact instead of presenting
partial approval as complete.

Remote status used for PR/CI planning expires after five minutes and is invalidated by a push or by
any bound source, remote, or branch change. Adding or editing remote URLs is not yet a UI feature.
Forgeboard does not perform a force push, merge the pull request, resolve remote conflicts, change
repository visibility, or configure GitHub credentials. The `gh` executable must already be
discoverable on `PATH` and authenticated; choosing a custom `gh` executable is not yet a UI feature.

Exact delivery also rejects multiple push destinations and custom remote helpers. Signed pushes,
push options, custom receive-pack commands, and submodule-recursive pushes are unsupported and are
disabled rather than added to the approved operation. Plain HTTP and Git protocol transports are
unsupported. These constraints keep one reviewed action bound to one ordinary destination branch
ref.

## Verification scope

Automated GitHub behavior is tested with local fake `gh` and SSH fixtures. The test suite makes no
real GitHub requests; using a real repository still depends on the user's installed, authenticated
`gh` session and the explicit native confirmations described above.
