# Host Artemis collaboration

Artemis remains a local desktop application. Hosting this service gives separate computers a
small authenticated coordination endpoint for allowlisted canvas metadata; it does not host
repositories, prompts, terminal output, agent transcripts, or project files.

## Recommended: Render Blueprint

The repository includes a production Blueprint at
`config/deployment/render.yaml`. It creates one Docker web service with:

- public HTTPS and WebSocket routing with managed TLS;
- a paid Starter instance that does not sleep;
- a 1 GB persistent disk mounted at `/data` for the SQLite database;
- generated signing and administrator secrets;
- `/healthz` deployment health checks; and
- a graceful shutdown window for active WebSocket connections.

Render's free web service is not suitable for this deployment. It cannot attach a persistent disk,
can spin down while idle, and loses a local SQLite database on restart or redeploy.

### Deploy

1. Push the repository branch containing the deployment files to the Git provider connected to
   Render.
2. In the Render Dashboard, choose **New → Blueprint** and select this repository.
3. Set **Blueprint Path** to `/config/deployment/render.yaml`.
4. Review the paid Starter service and 1 GB disk, then apply the Blueprint.
5. Wait for the service health check to pass.
6. Open `https://<your-render-hostname>/healthz`. It must return an `ok` status before Artemis is
   configured.
7. In the Render service's Environment page, securely reveal and copy
   `FORGEBOARD_COLLAB_ADMIN_TOKEN`. Do not place it in source control or send it with an invite.

Render assigns a public `onrender.com` hostname automatically. A custom domain can replace it later.
For a hostname such as `forgeboard-collaboration.onrender.com`, enter these values in
**Artemis → Settings → Connectivity**:

- **Collaboration server URL:** `wss://forgeboard-collaboration.onrender.com`
- **Collaboration management API URL:** `https://forgeboard-collaboration.onrender.com`

Enter the generated administrator token only when creating or recovering a room. Artemis clears
it immediately. After the room connects, **Create room + copy 10-minute invite** produces the
one-use link for the other person's Artemis installation.

## Required production properties

Keep the deployment at one instance while it uses SQLite. The attached disk is single-writer storage
and horizontal scaling would require replacing SQLite plus the in-memory connection/rate-limit
coordination with shared services.

The Blueprint intentionally sets `FORGEBOARD_COLLAB_REQUIRE_ORIGIN=false` because the native
Electron WebSocket client does not send a browser origin. Authentication still requires signed,
short-lived room credentials; exact role checks, rate limits, message limits, and the metadata
allowlist remain active.

Changing `FORGEBOARD_COLLAB_SIGNING_KEY` invalidates outstanding access and invite tokens. Preserve
the generated key and the `/data` disk across deploys. Keep Render's disk snapshots enabled and
periodically test restoration.

## Other hosts

The same Dockerfile can run on another Docker host that provides all of the following:

- a public HTTPS domain with WebSocket upgrade support;
- an injected `PORT` value or explicit `FORGEBOARD_COLLAB_PORT`;
- persistent storage mounted at `/data`;
- durable secret values for `FORGEBOARD_COLLAB_SIGNING_KEY` and
  `FORGEBOARD_COLLAB_ADMIN_TOKEN`; and
- a single active service instance.

Railway can use `apps/collab-server/Dockerfile`, a volume mounted at `/data`, and a generated public
domain. A VPS can run the image behind Caddy or nginx. Do not expose port 1234 directly to the
internet without TLS.
