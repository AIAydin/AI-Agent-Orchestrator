# Remote Git and GitHub delivery

Artemis can configure a project's ordinary Git remotes, push a completed managed agent run and,
when the optional GitHub CLI is available, inspect GitHub, create a pull request from a revalidated
pushed-commit snapshot, and read CI for the exact selected commit. Remote and GitHub CLI setup,
delivery choices, and actions are available in the desktop UI. They do not require source edits,
environment files, JSON, or hand-written manifests.

## What you need

- A Git project. Projects cloned in Artemis normally have an `origin` remote. Otherwise use
  **Settings → Git & previews → Git connections** to add a credential-free HTTPS/SSH target or choose
  a local bare/worktree Git repository. Local filesystem remotes can be used for push testing and
  local delivery.
- A completed writable Agent run with committed changes in its Artemis-managed worktree.
- One or more project checks configured under **Settings → Commands & checks**.
- For GitHub repository, pull-request, and CI actions only: an optional `gh` executable authenticated
  for the selected GitHub or GitHub Enterprise host. Settings can use automatic desktop `PATH`
  discovery or a native picker for a custom executable. Artemis reports missing, unverified,
  identity-changed, or unauthenticated state and never asks for or stores a GitHub token. It resolves,
  hashes, version-validates, and pins the selected executable; disables CLI telemetry, prompts, and
  update checks; and rejects configured HTTP Unix-socket routing before API actions. Automatic
  discovery is passive after startup or a privacy reset. The first explicitly confirmed **Check
  GitHub** action first runs only the disclosed path and SHA-256 with literal `--version` in a
  credential-free environment. Authentication and API commands stay blocked unless that exact probe
  succeeds and returns a valid GitHub CLI version; after it succeeds, the same confirmed status action
  may continue with its disclosed authentication and repository checks. Reviewing **Use automatic
  GitHub CLI** in Settings performs the same validation before applying the selection.

Choose the default remote name under **Settings → Git & previews → Remote automation**. A Git / PR
node can override that name for its own saved configuration. The **Git connections** section can:

- inspect path-free fetch/push descriptors for any saved Git project;
- add a credential-free HTTPS/SSH target entered in the form or a local Git target selected natively;
- replace the one URL of a simple repository-local managed remote;
- remove an exactly reviewed repository-local remote section and its complete disclosed
  remote-tracking refs; and
- choose, validate, refresh, or return to automatic GitHub CLI discovery.

Each change has a renderer review followed by a separate cancel-default native confirmation and
applies immediately rather than waiting for **Save settings**. Main rechecks the repository, config
revision, local destination or executable identity, and window authority before mutation. Remote
configuration changes are local-only: they do not fetch, push, authenticate, run `ls-remote`, or test
reachability. Included, inherited, worktree-specific, ambiguous, or otherwise advanced remotes remain
visible but read-only unless their exact repository-local state can be changed safely.

For delivery, main captures the one exact effective push URL while the Git / PR renderer remains
free of filesystem paths and configured effective Git URLs. The Settings form can submit a network
URL the user entered; local target and custom executable paths remain native-only. Validated PR and
CI result URLs cross the typed boundary only so the UI can display or copy them.

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

Artemis pushes the approved source object ID to the full destination branch ref with ordinary
non-force semantics. The command contains exactly one source-object-to-destination-branch refspec;
it does not implicitly send tags or any other ref. Execution uses the exact approved URL literal
instead of the remote name, converts a local destination to an absolute path, and enables only that
destination's file, HTTPS, or SSH protocol. Artemis never offers force push. A non-fast-forward
remote rejects the push without being overwritten.

## Create a GitHub pull request

1. After the exact branch is pushed, select **Check GitHub auth & repository** and approve the
   on-demand native read confirmation.
2. Artemis verifies the authenticated host and repository, remote base commit, and that the
   remote destination branch equals the exact reviewed source HEAD.
3. Enter the pull-request title and body in the node and choose draft mode if desired.
4. Select **Review pull request**, review the point-in-time plan, and continue to the native
   confirmation. The native disclosure includes the exact title and body as well as their digest,
   the repository, branches, remote commits, local commits/files, and readiness evidence.
5. After creation, Artemis shows the validated URL. Use **Copy pull request URL** to place it on
   the clipboard; Artemis does not permit arbitrary renderer navigation.

The pull-request body is sent to `gh` through standard input, not a shell or command-line argument.
The URL returned by `gh` is accepted only when it is HTTPS, contains no credentials/query/fragment,
and identifies the approved host, owner, repository, and pull-request number.
Artemis revalidates the reviewed remote head immediately before the create request, but GitHub
pull requests follow a branch name rather than an immutable commit ID. Concurrent movement can race
that request, and later movement of the branch can change the pull request's contents; the UI does
not claim atomic or permanently SHA-bound creation.

## Read exact-head CI

Select **Check CI for exact HEAD** after a successful GitHub status check. The action is explicit and
never polled. Artemis asks `gh` for at most 20 recent runs, validates every result URL, and shows
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
- Git connection plans are separately owner-bound, expiring, single-use, and revision-bound. A local
  target must be a real worktree or bare Git repository whose root/common-directory identity still
  matches. Removal deletes only the reviewed `remote.<name>` local section and disclosed refs with
  exact old-object checks; branch upstream/push settings and `remote.pushDefault` are not rewritten.
- Remote removal holds Git's conventional configuration lock and retains the byte-exact original
  config until the exact ref transaction and postconditions verify. Caught failures roll back when
  the ref transaction provably did not apply. If the app or operating system stops inside that
  narrow cross-file window, the lock and recovery staging file can remain and block later Git config
  writes; automated repair for this interrupted state is not yet available in the UI.
- Custom GitHub CLI validation runs only the exact selected executable with literal `--version` in a
  minimal environment that excludes ambient GitHub tokens and authentication variables. Actual
  explicitly confirmed GitHub actions may use the chosen CLI's existing authenticated account and
  user-owned network configuration. Every plan binds CLI source, filename, absolute native-only
  path, SHA-256, and executable identity; the binding is checked before every `gh` command.
- A passively detected automatic CLI is not treated as available after startup or privacy reset.
  Its first confirmed status check routes the exact identity-bound `--version` probe through the
  same credential-free validation runner. Nonzero or malformed version output fails before any
  authentication, Unix-socket configuration, repository, pull-request, or CI command can run.
- Network Git remotes must use credential-free HTTPS or SSH transport. Plain HTTP and Git protocol
  remotes, embedded credentials, URL query values, fragments, unsupported helpers, and ambiguous
  remote identities fail closed. Repository- and worktree-scope `credential.*`, `http.*`, and URL
  rewrite configuration is rejected for Artemis pushes. Matching active URL rewrites from any
  scope are also rejected immediately before execution so they cannot retarget the approved
  literal.
- Global and system Git credential and network configuration remain a user-owned trust boundary.
  This includes credential helpers, headers, cookies, client certificates, proxies, and TLS
  settings, plus the user's SSH configuration, proxy commands, and agent. Those facilities may
  execute helpers or contact configured intermediaries; Artemis does not make a categorical
  no-redirect guarantee across that trusted stack. GitHub actions may use `gh`'s existing
  authenticated session; Artemis stores neither credential.
- A local filesystem remote's exact path stays in main and appears only in the native confirmation.
  The renderer receives the fixed label **Local Git repository**. The destination repository's
  receive hooks and Git configuration can execute as the operating-system user during a push, so a
  local destination must be trusted.
- Before Artemis contacts the push destination, it verifies the complete approved source object
  closure with lazy fetching disabled. A partial clone missing an object therefore fails closed
  before destination contact instead of fetching from a promisor remote implicitly.
- Artemis blocks its own push from a shallow repository or a history containing Git LFS pointer
  content, because it cannot prove complete history or separately disclose and approve the LFS
  object upload. These push-only guards do not categorically block exact inspection, or PR/CI
  actions for an exact branch that was already pushed through another trusted workflow.
- Executable or redirected source `pre-push` hooks and configured source hook paths block
  Artemis's push. They are not a prerequisite for exact inspection, PR creation, or CI reads of
  an already-pushed branch. Destination-side receive hooks remain part of the destination's trust
  boundary.
- Audit rows contain bounded action metadata and digests, not the pull-request body, repository
  file contents, local worktree paths, tokens, or credential-bearing URLs.

## Deliberate limits

Actionable plans support at most 256 commits, 256 changed files, and 65,536 total disclosed path
characters. Pull-request bodies support at most 32,768 characters. A repository can expose at most
32 remotes to this surface. Artemis refuses oversized or truncated impact instead of presenting
partial approval as complete.

Remote status used for PR/CI planning expires after five minutes and is invalidated by a push, a
GitHub CLI selection change, or any bound source, remote, or branch change. Artemis does not
perform a force push, merge the pull request, resolve remote conflicts, change repository visibility,
or configure GitHub credentials. The selected `gh` executable must already be installed and
authenticated; Artemis validates and uses it but does not install it or sign into GitHub.

Exact delivery also rejects multiple push destinations and custom remote helpers. Signed pushes,
push options, custom receive-pack commands, and submodule-recursive pushes are unsupported and are
disabled rather than added to the approved operation. Plain HTTP and Git protocol transports are
unsupported. These constraints keep one reviewed action bound to one ordinary destination branch
ref.

## Verification scope

Automated GitHub behavior is tested with local fake `gh` and SSH fixtures. The test suite makes no
real GitHub requests; using a real repository still depends on the user's installed, authenticated
`gh` session and the explicit native confirmations described above.
