import type { LucideIcon } from 'lucide-react';
import {
  Bot,
  Container,
  Eye,
  FolderSearch,
  GitBranch,
  HardDrive,
  Keyboard,
  Play,
  ShieldCheck,
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
      'Create a project, configure a node, review the exact launch, and inspect its changes.',
    keywords: ['start', 'onboarding', 'workflow', 'agent', 'run', 'approval', 'demo'],
    icon: Play,
    steps: [
      'Open or create a Git project from the welcome screen.',
      'Add an Agent node from the left rail and describe the concrete outcome in its inspector.',
      'Choose Review & run, inspect the executable, arguments, context, permissions, and worktree, then approve that exact launch.',
      'Watch live output in the activity drawer. Review Staged & unstaged before committing; Changes vs base shows committed work against the run’s immutable base.',
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
    title: 'An agent CLI is not detected',
    summary: 'Use the bundled demo immediately or point Forgeboard at an installed executable.',
    keywords: ['missing', 'cli', 'codex', 'claude', 'gemini', 'opencode', 'executable', 'path'],
    icon: Bot,
    steps: [
      'Open Settings → Agents & runtime and find the provider.',
      'Choose Browse beside Executable override and select the CLI program; no PATH or file editing is required.',
      'For Codex or Claude Code, use the connection card after selecting the executable. Gemini, OpenCode, and custom CLIs keep their existing readiness flow.',
      'If no coding-agent CLI is installed, select Deterministic test agent to exercise local agent execution and Git review offline.',
    ],
  },
  {
    id: 'moved-project',
    title: 'A project was moved or renamed',
    summary: 'Reconnect the saved project to its new folder through the recovery flow.',
    keywords: ['moved', 'renamed', 'missing', 'repository', 'repo', 'folder', 'recovery', 'locate'],
    icon: FolderSearch,
    steps: [
      'Open the missing project from Recents to see its recovery action.',
      'Choose Locate project and select the repository at its new location.',
      'Review the repository identity and warnings before confirming the replacement path.',
      'Forgeboard preserves the project record and canvases; it does not silently substitute a different repository.',
    ],
  },
  {
    id: 'review-changes',
    title: 'Review an agent’s Git changes',
    summary: 'Compare the owned worktree with its immutable base before accepting anything.',
    keywords: ['git', 'diff', 'base', 'worktree', 'commit', 'review', 'changes', 'branch'],
    icon: GitBranch,
    steps: [
      'Open the activity drawer after a writable Agent run finishes and choose Review this agent worktree.',
      'Use Staged & unstaged to inspect current edits and stage only the hunks you intend to commit.',
      'Use Changes vs base for a read-only view of committed work between the persisted immutable base and the owned worktree HEAD.',
      'Add a Git / PR node, select the completed terminal agent run, and inspect its exact branch, HEAD, commits, changed files, divergence, remote, and readiness.',
      'Prepare a push or pull request, review the exact push plan or point-in-time pull-request plan, then continue to the cancel-default system confirmation. Forgeboard never force-pushes; GitHub pull requests still follow their remote branch.',
      'GitHub authentication, repository details, and CI are queried only when requested through the optional local gh CLI; Forgeboard stores no GitHub token.',
    ],
  },
  {
    id: 'remote-delivery-blocked',
    title: 'Remote delivery is blocked',
    summary:
      'Diagnose a missing remote, GitHub CLI setup, stale exact-head status, or rejected normal push from the UI.',
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
      'Select the completed agent run and choose Inspect exact Git state. Use a remote name discovered beside the Remote field; a Forgeboard-cloned repository normally has origin. If none is discovered, this project has no deliverable remote, so keep the review local or clone the intended repository through Forgeboard’s welcome UI.',
      'A missing or signed-out GitHub CLI blocks only optional repository, pull-request, and CI actions. Normal Git push still uses the selected remote and its existing credential helper or SSH setup; complete provider-owned GitHub CLI installation or sign-in, then choose Check GitHub auth & repository again.',
      'If GitHub reports a head mismatch or an exact plan/status expires, refresh exact Git state, review and push the current approved HEAD if needed, then rerun the on-demand GitHub check. Forgeboard never treats an earlier result as current.',
      'A non-fast-forward push is rejected without force. Use a new writable Agent run to reconcile the remote changes, review and approve that new exact HEAD, then prepare another normal push.',
    ],
  },
  {
    id: 'docker-readiness',
    title: 'Docker isolation is unavailable',
    summary: 'Validate the local Docker runtime and fill every required container field in the UI.',
    keywords: ['docker', 'container', 'image', 'network', 'isolation', 'runtime', 'credentials'],
    icon: Container,
    steps: [
      'Open Settings → Agents & runtime → Docker isolation.',
      'Choose the Docker executable, image, and absolute executable path inside that image.',
      'Select Check Docker and resolve every reported readiness issue before saving.',
      'Forgeboard never mounts host credentials. If imported settings request it, turn that inactive preference off, then authenticate inside the selected image separately.',
    ],
  },
  {
    id: 'preview-not-ready',
    title: 'A development preview does not become ready',
    summary:
      'Check the literal command, project-relative folder, readiness path, and process logs.',
    keywords: ['preview', 'port', 'server', 'command', 'readiness', 'localhost', 'logs', 'browser'],
    icon: Eye,
    steps: [
      'Open Settings → Git & previews and configure an executable plus one literal argument per line.',
      'In the Preview node, select the project-relative working folder and an HTTP readiness path such as /.',
      'Start the preview and inspect its raw process logs; Forgeboard does not invoke a shell or evaluate a command string.',
      'If the server binds a different host or port, update its literal arguments or the preview port range in Settings.',
    ],
  },
  {
    id: 'restore-data',
    title: 'Restore local data safely',
    summary: 'Use verified backups, owner-bound canvas snapshots, or reviewed portable import.',
    keywords: ['backup', 'restore', 'snapshot', 'import', 'database', 'recovery', 'autosave'],
    icon: HardDrive,
    steps: [
      'Open Settings → Data & privacy and check Backup health before relying on a backup.',
      'Use Canvas recovery to review an owner-bound snapshot’s node and connection counts, timestamp, and exact content hash before restoration.',
      'Choose merge or replace for portable import, then review its counts, size, hash, and conflict behavior before native confirmation.',
      'Keep automatic backups enabled and choose their folder, interval, shutdown behavior, and retention entirely in Settings.',
    ],
  },
  {
    id: 'privacy-boundary',
    title: 'Understand what can leave this device',
    summary:
      'Forgeboard has no account, telemetry, analytics, model proxy, or default collaboration connection.',
    keywords: ['privacy', 'telemetry', 'network', 'provider', 'outbound', 'data', 'collaboration'],
    icon: ShieldCheck,
    steps: [
      'Open Settings → Data & privacy to see local database, transcript, backup, and retention locations.',
      'Before every agent launch, inspect the named provider, exact context files, environment variable names, and network boundary.',
      'Provider CLIs may send approved prompts and context under their own terms; Forgeboard never hides that disclosure.',
      'Collaboration remains inactive until you explicitly configure and approve a connection. Application update checks run only when you select Check for updates and approve the exact GitHub request; Forgeboard never downloads or installs updates automatically.',
    ],
  },
  {
    id: 'keyboard-navigation',
    title: 'Work without a mouse',
    summary:
      'Open the command palette, navigate dialogs, and use canvas controls from the keyboard.',
    keywords: ['keyboard', 'shortcut', 'command palette', 'accessibility', 'focus', 'escape'],
    icon: Keyboard,
    steps: [
      'Save any keyboard-preset change, then open the command palette with the active shortcut shown above and type an action name.',
      'Use Arrow keys to choose an action, Enter to run it, and Escape to close overlays.',
      'Use Tab and Shift+Tab to move through visible controls; the Settings dialog keeps focus inside until closed.',
      'Change the keyboard preset, density, theme, and reduced-motion preference in Settings → Appearance.',
    ],
  },
  {
    id: 'custom-permissions',
    title: 'Build a Custom permission profile',
    summary:
      'Configure a reusable host disclosure policy or Docker boundary without editing a file.',
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
      'Open Settings → Permissions and choose Host or Docker for the Custom profile.',
      'Host path, visibility, executable, development-server, and test choices are declared policy: cwd is not an operating-system sandbox and descendants are not constrained.',
      'Docker technically enforces one whole-worktree read-only or read-write mount, non-root execution, network mode, CPU, and memory limits; host credentials remain unmounted.',
      'Allowing ignored or sensitive worktree visibility does not attach a file as context. Forgeboard context still requires exact per-file approval.',
      'Choose Custom as the default or on an Agent node, then review its complete effective profile and limitations before approving the exact launch.',
    ],
  },
  {
    id: 'run-will-not-start',
    title: 'A run will not start',
    summary:
      'Resolve validation, ownership, capacity, or approval issues without editing configuration files.',
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
      'Read the node status and activity message; Forgeboard reports missing prompt, adapter, permission, or dependency fields directly.',
      'Confirm the project still exists and that a writable run can create an owned Git worktree.',
      'If execution capacity is full, interrupt or finish an existing run before retrying.',
      'Prepare the launch again after any change: approvals bind to one exact, current plan and are never reused silently.',
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
