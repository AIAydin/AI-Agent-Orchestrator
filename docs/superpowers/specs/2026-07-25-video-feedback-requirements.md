# Video feedback — full requirements (2026-07-25)

Source: owner's 31-min narrated walkthrough (`/Users/aydin/Documents/forgeboard.mp4`),
transcribed with whisper-large-v3-turbo. Items are grouped into workstreams
(WS-A … WS-K). Timestamps refer to the video. Where the owner reversed himself,
the LATER statement wins and is the one recorded here.

General style rules (standing owner preferences): terse friendly copy, no tiny
fonts, selects over free text, simple over configurable — "who's going to do
that?" applies to every advanced option. When in doubt, delete.

## WS-A — Template & chrome removals

1. Empty-canvas card (0:16): replace the two buttons ("Add a product brief",
   "Add a task") with a single **"Add an agent"** button (opens/uses the same
   flow as clicking an agent in the rail — default agent is fine). Keep the
   card otherwise terse.
2. Node templates rail — REMOVE these templates entirely from the palette and
   any "add node" pickers (the node kinds may remain in code for old saved
   canvases, but they must not be creatable): **Agent** (2:22 — the AGENTS list
   above covers it), **Task** (4:29), **File** (4:47 — replaced by WS-B minimal
   file node), **Diff / review** (6:12 — the Changes drawer covers it),
   **Review gate** (11:12), **Git / PR** (11:53, 12:42 — and do NOT add a PR
   button to the git-pr node; the agent-node PR action in WS-E replaces it),
   **Diagram** (12:46), **Group** (14:31).
3. Sidebar: remove the branch section ("main /Users/…/earth-sim") between
   Project files and AGENTS (1:33) — branches are reflected on agent nodes.
4. Node auto-names (4:08): remove "Hermes" from the name pool (collides with a
   well-known tool) and add several new names so the pool stays large.
5. Top bar (17:28–17:53): remove **Commands** (⌘/Ctrl+K entry can stay on the
   keyboard but the button goes), remove the **Workflows** tab, remove the
   **Checks** tab. Keep Activity, Changes, History.
6. Changes drawer (16:58): remove the "Open externally" action; verify the
   apply/keep/discard flow works.

## WS-B — Project files & the minimal file node

1. Show git-ignored files in the project tree (0:30): do not hide them; keep
   the shield/ignored marker. ("They should be able to see ignored files" —
   repeated ~25:40.)
2. Clicking a file in the tree opens a **minimal file node** on the canvas
   (0:44, 4:47–5:27): title bar = auto name + file name; body = the file's
   code, scrollable (read-only is fine); NO Settings, NO Choose, no other
   chrome. This replaces the File template (removed in WS-A).
3. Fix the attach-to-agent failure (14:45–15:02): attaching a file/context to
   an agent errors with the sticky toast "Agent controls require an exact
   persisted Agent node." Attachment must work against live agent session
   nodes; the toast must stop appearing in normal flows.

## WS-C — Node simplifications

1. Product brief (2:55–3:21): remove **Attached items**, **Prompt variables**,
   and **Done when**; keep the markdown/requirements + **checklist**.
2. Test node (9:55–10:34): drop the Configure step entirely. Just: editable
   name, one command input, small description, Run (+ preview of output).
   Connectable to agents (its context flows to a connected agent).
3. Note / image node → simple **note** (13:51–14:24): title + note text box
   only. No images, no Choose image, no extra sections.
4. Video node (5:38–6:05): make playback work reliably for all common file
   types (it intermittently fails to load); remove the extra controls under
   the player — keep just the video.
5. Every node keeps its header **settings / comments / history** popover
   (9:27–9:34 — this REVERSES the earlier per-node "remove settings" remarks).

## WS-D — Canvas UX

1. Auto-placement (7:30–7:53): a newly added node must not overlap existing
   nodes — find nearby free space automatically.
2. Connector handles (8:24–8:44): make source/target dots clearly visible
   (small dot/line affordance, stronger on hover/drag) so it's obvious where
   you can connect from and to.
3. Preview/mobile-preview nodes (8:16): resizable from all edges/corners, not
   just one corner.
4. Node render quality (18:0x): nodes look blurry/low-quality at some zooms —
   improve crispness (device-pixel-ratio aware rendering / avoid blurring
   transforms) without adding latency; applies to every node.
5. Saving indicator (10:49): "Saved locally" must reflect reality — show
   saving in progress and flip to saved when the write completes.
6. Project switcher (16:26–16:40): clicking the project name in the top-left
   opens a dropdown listing recent projects (click to switch) + "New project"
   — it must NOT navigate to the launcher/homepage.

## WS-E — Agent node & agent runtime

1. Worktree visibility (20:14, ~19:5x): the node shows which worktree/branch
   and directory the session is in (terse line in the bottom strip).
2. Access select: include **"Write in current directory"** which runs the CLI
   directly in the project directory (no worktree) (21:36–21:56). Remove
   **Custom** entries from agent/access/profile selects (22:16, "custom
   profile as well").
3. NOT sandboxed (21:57–22:13): sessions run the user's real CLIs with their
   real environment/config — auth, history, `resume`, MCP servers all work
   exactly as in a normal terminal. No env allowlist stripping for agent
   sessions.
4. PR action (22:45–23:09): a small button on the agent node that takes the
   branch's changes and creates a pull request automatically (gh CLI), with
   one terse confirmation warning first. Nice minimal UI.
5. Claude Code renders "old looking" (21:06): ensure the newest installed CLI
   binary is what launches (PATH/version resolution) and the terminal renders
   it correctly.
6. Launch reliability: in the video a Codex node sits at "Starting…" for 14+
   minutes (19:30–20:30 frames). Find and fix the hang; failures must surface
   an error + Retry, never an endless Starting state.
7. Logos (1:47, 20:42): use the real brand logos — OpenAI/Codex, Claude,
   Google Gemini, OpenCode, GitHub, Docker — as inline SVGs wherever agents
   appear (rail list, node title bars, settings). Monogram letters go away.

## WS-F — Docker isolation

1. "Docker isolated" access profile must actually work (22:21–22:31): pick it
   and the session's worktree runs inside a container it creates. No separate
   Docker node ("we don't need the docker node").
2. Settings → Docker (24:5x): sync with the local Docker daemon — list/choose
   existing images/containers or create one; remove the manual container-image
   text field and other manual knobs.

## WS-G — Settings overhaul

1. Agents & runtime (19:3x–19:5x): remove the four per-agent configuration
   blocks (Codex, Claude Code, Google Gemini, OpenCode) — agents work
   out-of-the-box per WS-E-3. Keep **GitHub CLI** and **Docker** entries.
   Remove the legacy terminal-CLI configuration section ("we already have
   terminals — remove all this", 23:15) including the custom-CLI prompt
   plumbing ("send the prompt as…", output format, launch arguments,
   version-check arguments — all of it, 23:45–24:30).
2. Remove the **Extensions** section (26:5x) and **Checks** settings (checks
   feature is removed in WS-A). Simplify **Git & previews** aggressively —
   "look how much stuff is just for git and previews" (~26:0x): keep only
   what's needed (worktree root, preview ports); cut the rest.
3. Permissions page (~25:3x): drastically simplify; remove rows nobody uses;
   keep the ignored-files visibility consistent with WS-B-1.
4. Appearance (18:5x): theme switching must work (light/dark/system), reduced
   motion must work; fix the errors on this page.
5. Connectivity (28:48–28:57): hosted mode — create an **invite link**; the
   invitee joins the host's actual session and edits the same canvas live.
   Simplify the page: name + color + invite link join/create. Advanced fields
   (server URLs, API URLs, room names) hidden away or removed.
6. Fix text/spacing issues across settings (24:4x "fix the spacing on this");
   paginate **Help & shortcuts** (29:46 — don't remove entries, paginate);
   update Help copy to match the app after all these changes (29:54); keep
   import/export local data.

## WS-H — Web preview: agent observation

1. "Let connected agents observe this page" must work (9:03–9:19): an agent
   connected to a web-preview node can see the page (snapshot/DOM/console via
   its peer channel) and can **request browser actions** (navigate, click,
   type) which execute in the preview. Keep the existing toggles as the
   opt-in.

## WS-I — Whiteboard

1. Select tool currently does nothing — make it select/move shapes (13:00).
2. Text tool does nothing — placing text must work (13:20).
3. Add **free draw** (pen) — not just shape stamps (13:29).
4. Deleting while a shape is selected must delete the shape, not the whole
   whiteboard node (13:13).

## WS-J — Voice commands

1. Natural-language understanding (29:06–29:25, 30:12): commands match intent,
   not exact phrases — "start up a codex agent" etc. must work even with
   varied wording (fuzzy/semantic matching over the registered actions,
   offline).
2. No confirmation step — after transcription the action just runs (29:21).

## WS-K — Branding

1. New Forgeboard logo (30:33): the current wordmark/monogram "looks like
   crap" — design a nicer, modern logo (SVG) and use it in the app chrome,
   launcher, and about screens.

## Explicitly NOT wanted / reversed

- No PR button on a Git/PR node — that node is gone (12:42); the PR action
  lives on the agent node (WS-E-4).
- No Docker node (22:24) — superseded by the working Docker-isolated profile.
- No workflow run button on the Workflows tab — "Ignore what I said there"
  (16:21); the tab itself is removed.
- Keep comments/settings/history popovers on all nodes (9:27) despite earlier
  per-node removal remarks.
- Keep collaboration color picker (28:53).
- Keep all keyboard shortcuts — paginate, don't trim (29:49).
