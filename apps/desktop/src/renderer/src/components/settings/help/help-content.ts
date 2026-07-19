import type { LucideIcon } from 'lucide-react';
import {
  Bot,
  Container,
  Eye,
  FolderSearch,
  GitBranch,
  GitMerge,
  HardDrive,
  Keyboard,
  Play,
  ShieldCheck,
  Unplug,
  Wrench,
} from 'lucide-react';

export interface HelpArticle {
  readonly id: string;
  readonly title: string;
  readonly summary: string;
  readonly keywords: readonly string[];
  readonly icon: LucideIcon;
  readonly steps: readonly string[];
}

export const HELP_ARTICLES: readonly HelpArticle[] = [
  {
    id: 'first-agent',
    title: 'Run your first agent',
    summary:
      'Set up a project, tell an agent what to do, check everything before it starts, and review its changes.',
    keywords: ['start', 'onboarding', 'workflow', 'agent', 'run', 'approval', 'demo'],
    icon: Play,
    steps: [
      'Open or create a Git project from the welcome screen — a Git project is simply a folder whose changes Git tracks for you.',
      'Add an Agent node from the left rail, then use its side panel to describe exactly what you want the agent to achieve.',
      'Choose Review & run to see exactly what Forgeboard is about to launch: the program it starts, what it passes to it, which files the agent may see, and what the agent is allowed to do. Approve the launch only when all of that looks right.',
      'Watch the agent work live in the activity drawer. When it finishes, review its changes: Uncommitted changes shows edits not yet saved to Git, and Committed changes compares the work the run saved against the starting point Forgeboard recorded for it.',
    ],
  },
  {
    id: 'provider-connection',
    title: 'Connect Codex or Claude Code',
    summary:
      'Use the official provider-owned browser sign-in without entering an API key or editing configuration.',
    keywords: [
      'oauth',
      'openai',
      'anthropic',
      'codex',
      'claude',
      'connect',
      'disconnect',
      'reconnect',
      'refresh',
      'cancel',
      'token',
    ],
    icon: Bot,
    steps: [
      'In first-run setup or Settings → Agents & runtime, choose Connect with OpenAI or Connect with Anthropic and review the native confirmation.',
      'The official provider CLI opens browser sign-in. Forgeboard never sees or stores the OAuth token, reads no provider credential store, and does not proxy model traffic.',
      'Wait for normalized Connected evidence. Needs refresh is not connected; choose Refresh or Reconnect. Use Cancel sign-in while active or Disconnect for a connected CLI.',
      'Expand Advanced only for an optional executable override, default model, or readiness check. The current override is validated for the reviewed connection action; save Settings separately to persist it.',
      'Gemini and OpenCode do not use this OAuth flow. Choose Deterministic test agent for a fully local no-account workflow.',
    ],
  },
  {
    id: 'agent-not-detected',
    title: 'Forgeboard cannot find your agent program',
    summary:
      'Try the built-in test agent right away, or tell Forgeboard where your agent program is installed.',
    keywords: ['missing', 'cli', 'codex', 'claude', 'gemini', 'opencode', 'executable', 'path'],
    icon: Bot,
    steps: [
      'Open Settings → Agents & runtime and find the provider — the maker of the agent you use.',
      'Choose Browse next to Executable override and pick the agent program on your computer. You do not need to edit any files or system settings.',
      'For Codex or Claude Code, connect through the provider card and complete the official browser sign-in. Forgeboard never sees or stores the provider token. Gemini, OpenCode, and custom tools keep their local readiness flow.',
      'If you do not have an agent program installed, choose Deterministic test agent. It behaves like a real agent, so you can practice running agents and reviewing their changes — even offline.',
    ],
  },
  {
    id: 'moved-project',
    title: 'A project was moved or renamed',
    summary: 'Point the saved project at its new folder so nothing is lost.',
    keywords: ['moved', 'renamed', 'missing', 'repository', 'repo', 'folder', 'recovery', 'locate'],
    icon: FolderSearch,
    steps: [
      'Open the missing project from your recent projects, and Forgeboard will offer to help you find it.',
      'Choose Locate project and pick the project folder in its new place.',
      'Check that the folder Forgeboard found really is your project, and read any warnings, before you confirm the new location.',
      'Forgeboard keeps your project history and canvases — your visual workspaces. It will never quietly swap in a different folder.',
    ],
  },
  {
    id: 'review-changes',
    title: 'Review what an agent changed',
    summary: 'Compare the agent’s work with where it started before you accept any of it.',
    keywords: ['git', 'diff', 'base', 'worktree', 'commit', 'review', 'changes', 'branch'],
    icon: GitBranch,
    steps: [
      'When a run that may change files finishes, open the activity drawer and choose Review this agent’s changes. The agent worked in a private copy of your project, so your main copy stays untouched.',
      'Use Uncommitted changes to look through the current edits, and mark only the changes you want to save into Git (a saved change is called a "commit").',
      'Use Committed changes for a read-only comparison of everything the run saved to Git, measured from the exact starting point Forgeboard recorded for it.',
      'Add a Git / PR node and select the finished agent run to see exactly where its work stands: the branch, the latest saved state, the saved commits, which files changed, how far it differs from your main copy, and whether it is ready to share.',
      'To share the work, prepare a push (send the saved commits to a shared copy of the project) or a GitHub pull request (a request to merge the work). Read the exact plan Forgeboard shows — it describes one specific, current state — then confirm in the system dialog, where Cancel is the default. Forgeboard never force-pushes; it will not overwrite other people’s work. A pull request still follows its branch on GitHub.',
      'Forgeboard only checks your GitHub sign-in, repository details, and automated checks (CI) when you ask it to, through the optional GitHub gh program on your computer. Forgeboard never stores your GitHub token or password.',
    ],
  },
  {
    id: 'remote-delivery-blocked',
    title: 'Sharing your work online is blocked',
    summary:
      'Work out why a project has no shared copy to send to, GitHub sign-in fails, a shown plan expires, or a push is rejected — all from the app.',
    keywords: [
      'git',
      'remote',
      'missing',
      'github',
      'gh',
      'head mismatch',
      'expired',
      'stale',
      'non-fast-forward',
      'push rejected',
      'ci',
    ],
    icon: GitBranch,
    steps: [
      'Select the finished agent run and choose Check changes to see where the work could go. Look at the names listed next to the Remote field — a project Forgeboard cloned for you normally has one called origin. If nothing is listed, this project has no shared copy to send work to, so keep reviewing it locally or clone the project from its online source using Forgeboard’s welcome screen.',
      'If the optional GitHub program gh is missing or signed out, only the GitHub extras — repository details, pull requests, and automated checks — are unavailable. Sending work with a normal Git push still works through the sign-in your computer already has. To use the extras, install gh or sign in to it (GitHub manages that sign-in), then choose Check GitHub sign-in and repository again.',
      'If GitHub reports a head mismatch — the shared copy’s latest state differs from yours — or a shown plan expires, check the changes again, review and push the current approved state if needed, then run the GitHub check again. Forgeboard never assumes an earlier result is still current.',
      'If the shared copy has changes yours does not, the push is rejected without force — Forgeboard never overwrites shared work (Git calls this "non-fast-forward"). Start a new run that can write files, let the agent merge in the shared changes, review and approve the new state, then prepare another normal push.',
    ],
  },
  {
    id: 'docker-readiness',
    title: 'Running agents in Docker is unavailable',
    summary:
      'Check that Docker works on this computer and fill in every required field in Settings.',
    keywords: ['docker', 'container', 'image', 'network', 'isolation', 'runtime', 'credentials'],
    icon: Container,
    steps: [
      'Open Settings → Agents & runtime → Docker isolation.',
      'Choose the Docker program, the image (a ready-made environment the agent runs in), and the full path to the agent program inside that image.',
      'Select Check Docker and fix every problem it reports before saving.',
      'Forgeboard never shares your computer’s credentials (sign-ins and keys) with the Docker environment. If settings you imported ask for that, turn that option off, then sign in separately inside the environment if you need to.',
    ],
  },
  {
    id: 'preview-not-ready',
    title: 'A website preview never becomes ready',
    summary:
      'Check the start command, the folder it runs in, the page Forgeboard waits for, and the server’s logs.',
    keywords: ['preview', 'port', 'server', 'command', 'readiness', 'localhost', 'logs', 'browser'],
    icon: Eye,
    steps: [
      'Open Settings → Git & previews and enter the program that starts your site, with one argument per line, written exactly as that program expects them.',
      'In the Preview node, pick the folder inside your project where the command runs, and the page Forgeboard should wait for — for example / for the home page.',
      'Start the preview and read its logs to see what the server says. Forgeboard runs your program directly, without a command-line shortcut layer, so write the full program and each argument separately.',
      'If the server listens on a different address or port than Forgeboard expects, adjust the arguments or change the preview port range in Settings.',
    ],
  },
  {
    id: 'preview-port-collision',
    title: 'A preview port is already in use',
    summary:
      'Release a stale Forgeboard preview or choose a safe loopback range without stopping an unknown process.',
    keywords: ['preview', 'port', 'collision', 'occupied', 'address in use', 'loopback', 'retry'],
    icon: Eye,
    steps: [
      'Stop stale Preview nodes from the app. Do not kill an unrelated process unless you recognize it.',
      'Open Settings → Git & previews and expand or move the preview port range if another local tool owns it.',
      'Check that the preview command uses the displayed host and port arguments instead of a different hard-coded port.',
      'Request a fresh reviewed start. Forgeboard does not reuse a failed reservation as a live preview session.',
    ],
  },
  {
    id: 'git-delivery-conflict',
    title: 'Git delivery stopped on a conflict',
    summary:
      'Inspect the real conflicted files; Forgeboard does not choose a side or report a completed merge.',
    keywords: ['git', 'merge', 'cherry-pick', 'conflict', 'diverged', 'delivery', 'resolution'],
    icon: GitMerge,
    steps: [
      'Open Changes and inspect every path Forgeboard reports as conflicted. Merge, squash, and cherry-pick conflicts remain in the primary checkout; rebase conflicts remain in the managed agent workspace.',
      'Resolve the files deliberately in the project editor or an explicitly opened external application, then stage every resolution.',
      'Use Review Continue to bind the current operation, commit, paths, staged resolution, and unstaged content to a cancel-default system confirmation. Use Review Abort to restore the pre-operation Git state.',
      'Run the required delivery checks and record human quality approval again because changed source invalidates the earlier evidence.',
      'Forgeboard supports reviewed fast-forward, merge-commit, squash, rebase, and cherry-pick delivery. For bounded text conflicts, compare Git base, ours, and theirs inline, edit the merged result, then review a separate apply-and-stage confirmation. Resolve binary, oversized, ignored, or sensitive files in a trusted external editor.',
    ],
  },
  {
    id: 'collaboration-offline',
    title: 'The collaboration server is offline',
    summary:
      'Keep working locally, check the approved endpoint, and reconnect without losing intent.',
    keywords: [
      'collaboration',
      'server',
      'offline',
      'reconnecting',
      'websocket',
      'tls',
      'local save',
    ],
    icon: Unplug,
    steps: [
      'Continue local work and confirm the top bar returns to Saved locally. Solo persistence does not depend on the collaboration server.',
      'Check the WebSocket and management URLs under Settings → Connectivity and, if you operate the server, verify its health and TLS proxy.',
      'Wait for automatic reconnect or explicitly leave and rejoin after correcting configuration.',
      'A same-field conflict can pause for review; Forgeboard does not silently declare the local or remote version the winner.',
    ],
  },
  {
    id: 'restore-data',
    title: 'Restore local data safely',
    summary:
      'Bring your work back from a checked backup, a canvas snapshot, or an imported file — after reviewing what each one contains.',
    keywords: ['backup', 'restore', 'snapshot', 'import', 'database', 'recovery', 'autosave'],
    icon: HardDrive,
    steps: [
      'Open Settings → Data & privacy and check Backup health to make sure your backups are recent and working before you rely on them.',
      'Use Canvas recovery to see what a snapshot contains — how many nodes and connections it has, when it was taken, and a fingerprint that proves it belongs to this project — before you restore it.',
      'When you import a file from another computer, choose whether to merge it with or replace your current data, then review what will change — item counts, size, and how conflicts are handled — before confirming.',
      'Keep automatic backups turned on. Their folder, how often they run, what happens when you quit, and how long they are kept are all chosen in Settings.',
    ],
  },
  {
    id: 'import-database-recovery',
    title: 'An import or database recovery was rejected',
    summary:
      'Preserve current files and use only an exact, validated Forgeboard export or SQLite backup.',
    keywords: [
      'malformed',
      'import',
      'database',
      'corrupt',
      'startup',
      'backup',
      'recovery',
      'quarantine',
    ],
    icon: HardDrive,
    steps: [
      'A malformed, oversized, structurally invalid, or newer-version portable export is rejected before confirmation and does not partially replace local data.',
      'If startup cannot open the database, do not edit it. Choose a known Forgeboard SQLite backup from the native recovery dialog.',
      'Review the backup identity, schema compatibility, size, and digest. Forgeboard copies and verifies the source; it never edits the backup in place.',
      'If no verified backup is available, cancel and preserve the files for diagnosis. Forgeboard will not silently create an empty replacement database.',
    ],
  },
  {
    id: 'privacy-boundary',
    title: 'Understand what can leave this device',
    summary:
      'Forgeboard has no account and no usage tracking, and it makes no hidden connections — nothing leaves your computer unless you set it up.',
    keywords: ['privacy', 'telemetry', 'network', 'provider', 'outbound', 'data', 'collaboration'],
    icon: ShieldCheck,
    steps: [
      'Open Settings → Data & privacy to see where your data lives on this computer and how long it is kept.',
      'Before every run, Forgeboard shows you exactly which agent provider is used, which files the agent may see, which setting names it receives, and what network access it has.',
      'The agent programs you approve may send your prompt and the files you shared to their own servers under their own terms. Forgeboard always tells you when that can happen.',
      'Collaboration remains inactive until you explicitly configure and approve a connection. Application update checks run only when you select Check for updates and approve the exact GitHub request; Forgeboard never downloads or installs updates automatically.',
    ],
  },
  {
    id: 'keyboard-navigation',
    title: 'Work without a mouse',
    summary:
      'Open the command palette, move through dialogs, and use canvas controls — all from the keyboard.',
    keywords: ['keyboard', 'shortcut', 'command palette', 'accessibility', 'focus', 'escape'],
    icon: Keyboard,
    steps: [
      'If you changed your keyboard preset, save it first. Then open the command palette with the shortcut shown above and start typing what you want to do.',
      'Use the arrow keys to pick an action, Enter to run it, and Escape to close any pop-up.',
      'Use Tab and Shift+Tab to move between controls. While a dialog is open, the keyboard focus stays inside it until you close it.',
      'Change the keyboard preset, density, theme, and reduced-motion option in Settings → Appearance.',
    ],
  },
  {
    id: 'custom-permissions',
    title: 'Create a Custom permission profile',
    summary:
      'Decide exactly what an agent may see and do on your computer or inside Docker — all from Settings, with no file editing.',
    keywords: [
      'custom',
      'permission',
      'cwd',
      'sandbox',
      'root',
      'sensitive',
      'ignored',
      'executable',
      'network',
    ],
    icon: ShieldCheck,
    steps: [
      'Open Settings → Permissions and choose whether your Custom profile applies to runs on your computer (Host) or inside Docker.',
      'On your computer, your choices about folders, visibility, programs, development servers, and tests are declared rules, not hard walls: the working folder (cwd) is not an operating-system sandbox, and programs the agent starts are not confined by it.',
      'Docker truly enforces its limits: the whole worktree is mounted read-only or read-write, the agent runs without administrator (root) rights, and its network, CPU, and memory limits apply. Your computer’s credentials — your sign-ins — are never shared in.',
      'Letting an agent see normally hidden or sensitive files in its worktree does not send those files to the agent provider. Files are only shared as context when you approve them one by one.',
      'Use your Custom profile as the default or pick it on an Agent node. Before you approve a launch, read the full summary of what the agent will be allowed to do, and the limits that still apply.',
    ],
  },
  {
    id: 'run-will-not-start',
    title: 'A run will not start',
    summary:
      'Fix missing information, ownership, capacity, or approval problems — all from the app.',
    keywords: [
      'error',
      'failed',
      'start',
      'capacity',
      'permission',
      'approval',
      'owner',
      'validation',
    ],
    icon: Wrench,
    steps: [
      'Read the status on the node and the message in the activity panel. Forgeboard tells you plainly what is missing, such as a prompt, an agent connection, or a permission.',
      'Make sure the project folder still exists where it was, and that Forgeboard can create a private working copy (a worktree) for a run that changes files.',
      'If the maximum number of runs is already in progress, stop one or wait for it to finish, then try again.',
      'After you change anything, prepare the launch again. Your approval always applies to one exact, current plan, and Forgeboard never quietly reuses an old approval.',
    ],
  },
] as const;

export function searchHelpArticles(query: string): readonly HelpArticle[] {
  const terms = query.toLocaleLowerCase().trim().split(/\s+/u).filter(Boolean);
  if (terms.length === 0) return HELP_ARTICLES;
  return HELP_ARTICLES.filter((article) => {
    const haystack = [article.title, article.summary, ...article.keywords, ...article.steps]
      .join(' ')
      .toLocaleLowerCase();
    return terms.every((term) => haystack.includes(term));
  });
}
