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
    summary: 'Open a project, add an agent, and review what it changed.',
    keywords: ['start', 'onboarding', 'workflow', 'agent', 'run', 'approval', 'demo'],
    icon: Play,
    steps: [
      'Open or create a Git project from the welcome screen — a Git project is simply a folder whose changes Git tracks for you.',
      'Click an agent in the AGENTS rail. The node launches that CLI right away — sign-in, config, and history come from your normal terminal setup.',
      'Type to the agent inside its node, exactly like a terminal.',
      'When it finishes, review its changes in the Changes drawer: apply, keep, or discard each one before it reaches your main copy.',
    ],
  },
  {
    id: 'provider-connection',
    title: 'Agents work out of the box',
    summary: 'No connection setup — Artemis launches the CLIs you already use.',
    keywords: [
      'openai',
      'anthropic',
      'codex',
      'claude',
      'gemini',
      'opencode',
      'connect',
      'sign in',
      'account',
      'token',
    ],
    icon: Bot,
    steps: [
      'Install the CLI you want — Codex, Claude Code, Gemini, or OpenCode — and sign in from any terminal.',
      'Artemis finds installed CLIs automatically. Settings → Agents & runtime shows what was found.',
      'Agent sessions run with your real environment, so sign-in, resume, and MCP servers work exactly as in a normal terminal.',
      'Artemis never sees or stores provider credentials and does not proxy model traffic.',
    ],
  },
  {
    id: 'agent-not-detected',
    title: 'Artemis cannot find your agent program',
    summary: 'Get the agent CLI installed and visible on this computer.',
    keywords: ['missing', 'cli', 'codex', 'claude', 'gemini', 'opencode', 'executable', 'path'],
    icon: Bot,
    steps: [
      'Open Settings → Agents & runtime to see which agent CLIs Artemis found.',
      'If yours is missing, install it from its provider or make sure its command is on your PATH, then reopen Artemis.',
      'Sign-in happens in the CLI itself — run it once in any terminal if it asks for an account.',
    ],
  },
  {
    id: 'moved-project',
    title: 'A project was moved or renamed',
    summary: 'Point the saved project at its new folder so nothing is lost.',
    keywords: ['moved', 'renamed', 'missing', 'repository', 'repo', 'folder', 'recovery', 'locate'],
    icon: FolderSearch,
    steps: [
      'Open the missing project from your recent projects, and Artemis will offer to help you find it.',
      'Choose Locate project and pick the project folder in its new place.',
      'Check that the folder Artemis found really is your project, and read any warnings, before you confirm the new location.',
      'Artemis keeps your project history and canvases — your visual workspaces. It will never quietly swap in a different folder.',
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
      'Use Committed changes for a read-only comparison of everything the run saved to Git, measured from the exact starting point Artemis recorded for it.',
      'To share the work, use the PR action on the agent node to turn its branch into a GitHub pull request. Read the exact plan Artemis shows — it describes one specific, current state — then confirm in the system dialog, where Cancel is the default. Artemis never force-pushes; it will not overwrite other people’s work.',
      'Artemis only checks your GitHub sign-in, repository details, and automated checks (CI) when you ask it to, through the optional GitHub gh program on your computer. Artemis never stores your GitHub token or password.',
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
      'Select the finished agent run and choose Check changes to see where the work could go. Look at the names listed next to the Remote field — a project Artemis cloned for you normally has one called origin. If nothing is listed, this project has no shared copy to send work to, so keep reviewing it locally or clone the project from its online source using Artemis’s welcome screen.',
      'If the optional GitHub program gh is missing or signed out, only the GitHub extras — repository details, pull requests, and automated checks — are unavailable. Sending work with a normal Git push still works through the sign-in your computer already has. To use the extras, install gh or sign in to it (GitHub manages that sign-in), then choose Check GitHub sign-in and repository again.',
      'If GitHub reports a head mismatch — the shared copy’s latest state differs from yours — or a shown plan expires, check the changes again, review and push the current approved state if needed, then run the GitHub check again. Artemis never assumes an earlier result is still current.',
      'If the shared copy has changes yours does not, the push is rejected without force — Artemis never overwrites shared work (Git calls this "non-fast-forward"). Start a new run that can write files, let the agent merge in the shared changes, review and approve the new state, then prepare another normal push.',
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
      'Open Settings → Agents & runtime → Docker.',
      'Choose the Docker program, the image (a ready-made environment the agent runs in), and the full path to the agent program inside that image.',
      'Select Check Docker and fix every problem it reports before saving.',
      'Artemis never shares your computer’s credentials (sign-ins and keys) with the Docker environment. If settings you imported ask for that, turn that option off, then sign in separately inside the environment if you need to.',
    ],
  },
  {
    id: 'preview-not-ready',
    title: 'A website preview never becomes ready',
    summary:
      'Check the start command, the folder it runs in, the page Artemis waits for, and the server’s logs.',
    keywords: ['preview', 'port', 'server', 'command', 'readiness', 'localhost', 'logs', 'browser'],
    icon: Eye,
    steps: [
      'In the Preview node, pick the folder your app runs from and the package script or command that starts it.',
      'Pick the page Artemis should wait for — for example / for the home page.',
      'Start the preview and read its logs to see what the server says.',
      'If the server listens on a different port than Artemis expects, change the preview port range in Settings → Git & previews.',
    ],
  },
  {
    id: 'preview-port-collision',
    title: 'A preview port is already in use',
    summary:
      'Release a stale Artemis preview or choose a safe loopback range without stopping an unknown process.',
    keywords: ['preview', 'port', 'collision', 'occupied', 'address in use', 'loopback', 'retry'],
    icon: Eye,
    steps: [
      'Stop stale Preview nodes from the app. Do not kill an unrelated process unless you recognize it.',
      'Open Settings → Git & previews and expand or move the preview port range if another local tool owns it.',
      'Check that the preview command uses the displayed host and port arguments instead of a different hard-coded port.',
      'Request a fresh reviewed start. Artemis does not reuse a failed reservation as a live preview session.',
    ],
  },
  {
    id: 'git-delivery-conflict',
    title: 'Git delivery stopped on a conflict',
    summary:
      'Inspect the real conflicted files; Artemis does not choose a side or report a completed merge.',
    keywords: ['git', 'merge', 'cherry-pick', 'conflict', 'diverged', 'delivery', 'resolution'],
    icon: GitMerge,
    steps: [
      'Open Changes and inspect every path Artemis reports as conflicted. Merge, squash, and cherry-pick conflicts remain in the primary checkout; rebase conflicts remain in the managed agent workspace.',
      'Resolve the files deliberately in the project editor or an explicitly opened external application, then stage every resolution.',
      'Use Review Continue to bind the current operation, commit, paths, staged resolution, and unstaged content to a cancel-default system confirmation. Use Review Abort to restore the pre-operation Git state.',
      'Run the required delivery checks and record human quality approval again because changed source invalidates the earlier evidence.',
      'Artemis supports reviewed fast-forward, merge-commit, squash, rebase, and cherry-pick delivery. For bounded text conflicts, compare Git base, ours, and theirs inline, edit the merged result, then review a separate apply-and-stage confirmation. Resolve binary, oversized, ignored, or sensitive files in a trusted external editor.',
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
      'Check the server addresses under Advanced in Settings → Connectivity and, if you operate the server, verify its health and TLS proxy.',
      'Wait for automatic reconnect or explicitly leave and rejoin after correcting configuration.',
      'A same-field conflict can pause for review; Artemis does not silently declare the local or remote version the winner.',
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
      'Preserve current files and use only an exact, validated Artemis export or SQLite backup.',
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
      'If startup cannot open the database, do not edit it. Choose a known Artemis SQLite backup from the native recovery dialog.',
      'Review the backup identity, schema compatibility, size, and digest. Artemis copies and verifies the source; it never edits the backup in place.',
      'If no verified backup is available, cancel and preserve the files for diagnosis. Artemis will not silently create an empty replacement database.',
    ],
  },
  {
    id: 'privacy-boundary',
    title: 'Understand what can leave this device',
    summary:
      'Artemis has no account and no usage tracking, and it makes no hidden connections — nothing leaves your computer unless you set it up.',
    keywords: ['privacy', 'telemetry', 'network', 'provider', 'outbound', 'data', 'collaboration'],
    icon: ShieldCheck,
    steps: [
      'Open Settings → Data & privacy to see where your data lives on this computer and how long it is kept.',
      'Before every run, Artemis shows you exactly which agent provider is used, which files the agent may see, which setting names it receives, and what network access it has.',
      'The agent programs you approve may send your prompt and the files you shared to their own servers under their own terms. Artemis always tells you when that can happen.',
      'Collaboration remains inactive until you explicitly configure and approve a connection. Application update checks run only when you select Check for updates and approve the exact GitHub request; Artemis never downloads or installs updates automatically.',
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
    title: 'Choose what an agent may do',
    summary: 'Pick a permission profile — the cards in Settings show exactly what each one allows.',
    keywords: [
      'permission',
      'profile',
      'cwd',
      'sandbox',
      'worktree',
      'docker',
      'credentials',
      'network',
      'isolated',
    ],
    icon: ShieldCheck,
    steps: [
      'Open Settings → Permissions and pick the default profile for new agent sessions.',
      'Read and plan only asks the provider not to write. It is a request, not an operating-system sandbox — the working folder (cwd) does not confine the agent.',
      'Write in a worktree gives the agent its own copy of your project; you review changes before they reach your main branch.',
      'Docker isolated truly enforces its limits: one worktree, no administrator (root) rights, and network, CPU, and memory caps. Your computer’s credentials — your sign-ins — are never shared in.',
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
      'Read the status on the node and the message in the activity panel. Artemis tells you plainly what is missing, such as an installed CLI or a permission.',
      'Make sure the project folder still exists where it was, and that Artemis can create a private working copy (a worktree) for a run that changes files.',
      'If the maximum number of runs is already in progress, stop one or wait for it to finish, then try again.',
      'After you change anything, prepare the launch again. Your approval always applies to one exact, current plan, and Artemis never quietly reuses an old approval.',
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
