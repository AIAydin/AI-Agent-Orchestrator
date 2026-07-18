# Optional self-hosted collaboration

Forgeboard's desktop application is local-first. Solo projects do not start, contact, or depend on this service. The collaboration server is an optional Hocuspocus/Yjs transport for teams that choose to share canvas metadata.

No source-code edit is required to run it. A local development server starts with safe localhost defaults:

```bash
corepack pnpm install
corepack pnpm dev:collab
curl http://127.0.0.1:1234/healthz
```

In development, a missing signing key creates an ephemeral key and prints a warning. Existing access and invite tokens consequently stop working when that process restarts. The server binds to `127.0.0.1`, permits room bootstrap only from loopback, and persists metadata in `./data/forgeboard-collab.sqlite`. Production mode refuses to start without explicit signing and administrator secrets.

The desktop client configures and controls ordinary room and invite sessions without source,
environment, or manifest edits. Its UI supports room creation, owner recovery and renewal,
paginated membership and audit access, version-safe role changes and revocation, invite redemption,
and current-session owner invite creation, copy, and revocation. Deployment environment variables
remain only for operators of this optional service; ordinary desktop users do not edit them.

## Desktop connection and recovery

In **Settings → Connectivity**, enable collaboration and enter the WebSocket server URL,
collaboration management API URL, collaborator identity, display name, and color. The management URL
must use HTTPS, except that plain HTTP is accepted for a loopback server on the same device. It is an
explicit setting: Forgeboard does not derive or guess it from the WebSocket URL.

The ordinary invite path accepts a trusted invite link and remains disabled until the explicit
server, management API, and identity fields are present. The pasted link is a password-style,
volatile field that clears after every accepted, rejected, cancelled, or malformed attempt. Before
redemption, a cancel-default native review shows the exact destinations, display identity, and an
invite SHA-256 fingerprint—not the raw link. The management service's returned access credential is
consumed by the main process and never returned to the renderer.

The advanced access-token path remains available for an already provisioned room. Enter the room
and current access token, then select **Connect with access token**. The access-token field clears
after every attempt; the token is held only in volatile main-process memory for the approved session
and automatic reconnect, and is cleared on leave, privacy reset, or quit. Its cancel-default native
confirmation identifies the exact network destination before the first connection. Supplying the
explicit management URL also binds owner invite management to that exact connected session.

The connected role is visible in Settings. Only a connected owner whose session is bound to the
explicit management URL sees room and invite administration. A disconnected user can create a room
or recover its owner from the same Settings form; the optional administrator credential clears
immediately and is never saved. Recovery warns that it rotates the owner version and invalidates
prior credentials for subsequent requests, messages, and reconnects. Connected owners can renew their expiring
credential, page through active members and the hash-chained audit trail, and explicitly apply or
revoke a non-owner membership. Each network read or effect has a fresh cancel-default native review,
and stale member versions force a refresh instead of replaying an outdated action.

For invites, the owner chooses editor, reviewer, or viewer access, a bounded lifetime, and a
maximum-use count. Create and revoke each require a fresh cancel-default native review. The UI lists
only token-free metadata for invites created during the current owner session: role, expiration,
and maximum uses. **Copy** requires a separate native review and writes the link from protected
main-process memory directly to the system clipboard; the raw link does not cross back through
preload or render in the page. Leaving, resetting privacy data, quitting, or changing the owning
session clears all volatile room-management authority, invite records, and credentials. This UI
does not claim to list every durable invite already present on the server.

Authenticated roles are enforced in both the desktop and server. Owners and editors can publish
graph metadata. Reviewers can add their own node comments through a separate main-owned operation
without gaining graph-write authority. Viewers remain read-only. A comment appears as shared only
after the server's correlated durable acknowledgement; rejected or timed-out delivery is shown as a
failure. Shared cursors, selections, active presence, and idle collaborator avatars are rendered as
metadata-only state.

For offline and restart recovery, the desktop stores only a bounded baseline, pending allowlisted
metadata intent, and an exact per-delivery candidate ledger in its local SQLite database, scoped to
the project, canvas, server, room, and authenticated subject. Staging plus receipt binding is one
transaction. Out-of-order acknowledgements therefore cannot erase an earlier accepted candidate or
misclassify a later rejection. Row and aggregate-byte limits fail closed, and the scope journal
expires after 30 days without activity. Reconnect performs a three-way merge: disjoint edits are
reapplied, same-field conflicts pause for review, and pending intent is retained rather than
replayed if the current role no longer permits it. Rejected comment additions remain quarantined
even beneath a newer unsettled delivery. A later acknowledged candidate containing the exact value
clears its quarantine. The UI also lets the user restore its text to the editor or explicitly
discard that exact device-local copy using its rejected-delivery token; a later identical rejection
is treated as new and appears again. Discarding does not mutate or delete server state. Because the
stale Yjs document still carries the rejected update clock, Forgeboard blocks further shared
publishing in that session and tells the user to leave and rejoin first. Recovery pauses without
applying a room snapshot if a known rejection cannot be persisted. Solo mode does not create a
journal entry or contact this service.

## What can and cannot leave a device

The server accepts only these Yjs top-level maps:

- `canvas`: canvas identifier, title, version, viewport, zoom, theme, and update time
- `nodes`: node identity, type, title, position/size, visual state, workflow status, and an opaque `localResourceId`
- `edges` and `groups`: graph relationships and layout metadata
- `tasks`: title, priority, assignee, dependencies, acceptance state, and workflow status
- `comments`: collaborator-authored comment text and resolution state
- `workflow`: identifiers, status, bounded attempts, and timestamps
- `reviews`: reviewer identity, approval state, and comment references

Presence has a separate strict shape for collaborator identity, cursor position, selected node IDs, and activity status. Stateless Hocuspocus messages are disabled because they would bypass the allowlist. A proposed update is applied to an isolated Yjs clone, size-checked, role-checked, and schema-validated before it is applied to or broadcast from the live room. Unknown roots and unknown nested properties are rejected rather than stripped.

Forgeboard's service does **not** accept or synchronize repository files, file contents, local paths, prompts, diffs, terminal output, environment values, secrets, or raw agent transcripts. A file node may carry an opaque local resource identifier and metadata-only availability state; each collaborator's desktop must resolve it against that person's own authorized checkout.

Titles and comments are intentionally human-authored text. A structural allowlist cannot determine whether someone manually pasted a secret or source code into a comment, so users should never paste sensitive content there. This limitation does not create an automatic repository-read path: the collaboration service has no repository filesystem access.

## Roles and authorization

| Role     | Read shared metadata | Edit canvas/task/workflow metadata | Write own comments/reviews | Manage room, members, invites, audit |
| -------- | -------------------- | ---------------------------------- | -------------------------- | ------------------------------------ |
| Owner    | Yes                  | Yes                                | Yes                        | Yes                                  |
| Editor   | Yes                  | Yes                                | Yes                        | No                                   |
| Reviewer | Yes                  | No                                 | Yes                        | No                                   |
| Viewer   | Yes                  | No                                 | No                         | No                                   |

Every WebSocket authenticates with a signed access token whose room, subject, role, version, issue time, expiration, and unique ID are validated. Authorization is then checked against the current SQLite membership record. Changing or revoking a membership increments its token version, invalidating previously issued tokens. A token for one room cannot open another room.

Invite tokens are HMAC-SHA256 signed, time-limited, room- and role-scoped, usage-limited, and recorded by unique ID. Redemption checks both the signature and the live invite record. Revoking the record immediately prevents later redemption; invite token values are never written to the audit log. Invite links put the token in the URL fragment so it is not sent in ordinary HTTP request paths or proxy access logs.

Relevant management endpoints are:

- `POST /v1/rooms` — create a room and its owner; requires the server administrator token in production
- `POST /v1/rooms/:roomId/owner-tokens/refresh` — renew a valid owner session without invalidating its other current tokens
- `POST /v1/rooms/:roomId/owner-tokens/recover` — administrator-authorized recovery that rotates the owner token version and invalidates every prior owner token
- `GET /v1/rooms/:roomId/members` — owner reads active, versioned memberships with bounded cursor pagination
- `POST /v1/rooms/:roomId/invites` — owner creates an editor, reviewer, or viewer invite
- `POST /v1/invites/redeem` — redeem a live invite for an expiring access token
- `DELETE /v1/rooms/:roomId/invites/:inviteId` — owner revokes an invite
- `PATCH /v1/rooms/:roomId/members/:subject` — owner changes a non-owner role and invalidates old tokens
- `DELETE /v1/rooms/:roomId/members/:subject` — owner revokes a non-owner membership
- `GET /v1/rooms/:roomId/audit` — owner reads the room's paginated audit trail

All request bodies are strict JSON schemas with a bounded size. API and WebSocket rates are limited per pseudonymous client-IP hash; WebSocket messages and persisted Yjs documents have independent size ceilings. CORS and WebSocket origin checks use exact origin matches—wildcards are refused.

Room creation, owner-token refresh/recovery, and membership mutations require a UUID
`Idempotency-Key`. Member deletion additionally requires `If-Match: "<tokenVersion>"`; member role
changes carry the same expected version in their strict JSON body. Exact retries replay without a
second mutation or audit event, while reuse for different input and stale membership versions return
conflicts. Replay records retain token-free response metadata and signed access claims—not raw
credentials—and are pruned after seven days and to at most 10,000 rows. An expired replay result
requires a new idempotency key.

Production always requires the server administrator token for room creation and owner recovery. If
no administrator token is configured in development or test mode, those two operations are allowed
only from the same machine's loopback interface. Ordinary owner refresh still requires a currently
valid owner access token; recovery increments the owner membership version specifically so a lost or
compromised token stops authorizing HTTP and WebSocket operations.

## Configuration

| Variable                                     | Development default                        | Production guidance                                                 |
| -------------------------------------------- | ------------------------------------------ | ------------------------------------------------------------------- |
| `NODE_ENV`                                   | `development`                              | Set `production`                                                    |
| `FORGEBOARD_COLLAB_HOST`                     | `127.0.0.1`                                | `0.0.0.0` in a container, with a firewall/reverse proxy             |
| `FORGEBOARD_COLLAB_PORT`                     | `1234`                                     | Any unprivileged internal port                                      |
| `FORGEBOARD_COLLAB_DATABASE_PATH`            | `./data/forgeboard-collab.sqlite`          | A persistent, encrypted volume                                      |
| `FORGEBOARD_COLLAB_SIGNING_KEY`              | Ephemeral random key                       | Required; at least 32 random bytes, stored in a secret manager      |
| `FORGEBOARD_COLLAB_ADMIN_TOKEN`              | Not needed for loopback bootstrap          | Required; at least 24 random characters, stored in a secret manager |
| `FORGEBOARD_COLLAB_ALLOWED_ORIGINS`          | Forgeboard desktop plus local Vite origins | Exact comma-separated production desktop/web origins                |
| `FORGEBOARD_COLLAB_REQUIRE_ORIGIN`           | `false`                                    | Defaults to `true`; keep enabled for browser-capable clients        |
| `FORGEBOARD_COLLAB_PUBLIC_INVITE_URL`        | `forgeboard://collaboration/invite`        | The installed client's invite URL handler                           |
| `FORGEBOARD_COLLAB_ACCESS_TTL_SECONDS`       | `28800` (8 hours)                          | 5 minutes to 7 days                                                 |
| `FORGEBOARD_COLLAB_MAX_INVITE_TTL_SECONDS`   | `604800` (7 days)                          | 5 minutes to 30 days                                                |
| `FORGEBOARD_COLLAB_HTTP_RATE_LIMIT`          | `120` per window                           | Tune behind an edge limiter                                         |
| `FORGEBOARD_COLLAB_WS_CONNECTION_RATE_LIMIT` | `60` per window                            | Tune for reconnect patterns                                         |
| `FORGEBOARD_COLLAB_MESSAGE_RATE_LIMIT`       | `600` per window                           | Tune for expected editing volume                                    |
| `FORGEBOARD_COLLAB_RATE_WINDOW_MS`           | `60000`                                    | Shared in-memory rate window                                        |
| `FORGEBOARD_COLLAB_MAX_HTTP_BODY_BYTES`      | `32768`                                    | Maximum 1 MiB                                                       |
| `FORGEBOARD_COLLAB_MAX_MESSAGE_BYTES`        | `1048576`                                  | Maximum 16 MiB                                                      |
| `FORGEBOARD_COLLAB_MAX_DOCUMENT_BYTES`       | `8388608`                                  | Maximum 64 MiB                                                      |

Changing the signing key invalidates outstanding invite and access tokens. Rotate it deliberately and notify collaborators. Multiple server replicas require a shared persistence and rate-limit design; this SQLite deployment is intentionally a reliable single-instance option.

## Container deployment

Build from the repository root so the workspace lockfile is available:

```bash
docker build -f apps/collab-server/Dockerfile -t forgeboard-collab .
docker run --name forgeboard-collab \
  --read-only \
  --tmpfs /tmp:rw,noexec,nosuid,size=16m \
  -p 127.0.0.1:1234:1234 \
  -v forgeboard-collab-data:/data \
  -e FORGEBOARD_COLLAB_SIGNING_KEY='replace-with-32-or-more-random-bytes' \
  -e FORGEBOARD_COLLAB_ADMIN_TOKEN='replace-with-a-separate-random-token' \
  -e FORGEBOARD_COLLAB_ALLOWED_ORIGINS='forgeboard://desktop' \
  forgeboard-collab
```

The image runs as UID/GID `10001`, has a built-in `/healthz` probe, and writes only to `/data` (plus the optional temporary filesystem shown above). Bind the service to loopback or a private container network; expose it publicly only through a TLS reverse proxy.

## TLS and reverse proxy

WebSockets carry bearer tokens and collaboration metadata. Production must use TLS (`https`/`wss`) from the client to the public endpoint. Caddy can terminate TLS and proxy HTTP upgrades with a minimal site block:

```caddyfile
collab.example.com {
  reverse_proxy 127.0.0.1:1234
}
```

For nginx, retain HTTP/1.1 upgrade headers and set conservative request limits:

```nginx
location / {
    proxy_pass http://127.0.0.1:1234;
    proxy_http_version 1.1;
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection "upgrade";
    proxy_set_header Host $host;
    client_max_body_size 1m;
    proxy_read_timeout 75s;
}
```

Do not terminate TLS on an untrusted hop. Restrict inbound traffic to the proxy, set `FORGEBOARD_COLLAB_ALLOWED_ORIGINS` to the exact origins emitted by approved clients, and keep token-bearing URL fragments and authorization headers out of proxy logs. Native clients that send no `Origin` require `FORGEBOARD_COLLAB_REQUIRE_ORIGIN=false`; use that only with TLS, short token lifetimes, and strict network access controls.

## Persistence, backups, and recovery

SQLite uses WAL mode, foreign keys, a busy timeout, startup integrity checking, and mode `0600` for a file-backed database. Yjs documents, memberships, invites, and the metadata-only audit trail are durable. Audit rows have database triggers preventing update/delete and a SHA-256 hash chain verified at startup. Audit details use a second allowlist and contain identifiers, roles, byte counts, pseudonymous IP hashes, and denial reasons—not request bodies, tokens, comment bodies, or synchronized values.

For a consistent online backup with the SQLite CLI:

```bash
sqlite3 /data/forgeboard-collab.sqlite ".backup '/backup/forgeboard-collab-$(date +%F).sqlite'"
sqlite3 /backup/forgeboard-collab-$(date +%F).sqlite "PRAGMA integrity_check;"
```

Alternatively, stop the container gracefully and copy `forgeboard-collab.sqlite` after shutdown; graceful shutdown checkpoints and truncates the WAL. Do not copy only the main database file while a live process may still have WAL data. Encrypt backup storage, restrict it like the live volume, set an operator-controlled retention policy, and test restoration periodically.

To restore, stop the server, place the verified backup at the configured database path with ownership `10001:10001` and mode `0600`, then start the server. Startup refuses a failed SQLite quick check or a broken audit hash chain. Keep the signing key in a separate secret-manager backup if outstanding tokens must survive recovery.

`GET /healthz` reports process health without database or room details. `GET /readyz` verifies that persistence is queryable. The service emits no telemetry, analytics, crash uploads, repository logs, or automatic diagnostics.
