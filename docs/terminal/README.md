# Interactive Terminal

The Terminal canvas node runs a real local PTY without requiring source, environment-file, JSON, or
manifest editing. Add the node from the node library, select it, and configure the process in the
inspector.

This page describes ordinary Terminal canvas nodes. The embedded session on a built-in Agent node
can start automatically after one explicit **Start** when **Write in a worktree** is selected,
because Electron main reconstructs the command from saved Agent state. Custom Agent sessions and
ordinary Terminal nodes retain the native confirmation described below.

## Configure and launch

The form exposes the executable, literal argument array, project-relative working directory, and
environment-variable names. New nodes inherit the Terminal shell and environment allowlist from
Settings. The native executable picker is available for ordinary path selection.

**Review & start** prepares an expiring, single-use plan but starts no process. The first dialog
shows the renderer-safe command and permission boundary. Continuing opens a separate native dialog
with the exact resolved executable, literal arguments, canonical working directory, environment
names, and PTY size. Cancel is the default in both steps. Main rechecks the project and directory
identities, executable identity, Settings allowlist, plan expiry, and originating window immediately
before spawning.

Arguments are never joined into a shell string. Environment values do not cross into the renderer
or node data; main reads only names that are both requested by the node and allowed in Settings, and
blocks loader/runtime injection variables.

## Runtime and history

The xterm surface renders ANSI output, sends raw keyboard input, and follows visible resize changes.
Live safety controls remain available until exit is confirmed or bounded graceful and force-stop
attempts are exhausted. An unconfirmed stop is reported honestly as lost rather than terminated.
Interrupt sends the PTY's interactive interrupt, and Restart always creates a fresh reviewed
session. Search operates on the retained display; Clear display does not delete retained history.

The UI-authored executable, literal arguments, project-relative directory, and environment names are
durable local canvas configuration. Historical `terminal_sessions` rows are separately path-free and
argument-redacted; the resolved canonical executable/directory and owning live-session exact overlay
remain only in main-process memory. Raw output is stored in private JSON-lines files capped at 16 MiB
per session, 256 MiB and 10,000 files in total. Replay is also byte/chunk bounded. The configured
transcript-retention window prunes expired sessions at startup, and complete local-data deletion
removes metadata and files. Terminal session history is not included in collaboration or portable
JSON exports.

## Security boundary

A Terminal process is not sandboxed. Its starting directory is constrained to a canonical directory
inside the selected project, but after launch it has the filesystem and network access of the
operating-system user. Use a dedicated OS account or an external sandbox when stronger isolation is
required. Do not pass secrets as arguments or print secrets unless you are comfortable retaining
them in local terminal history.
