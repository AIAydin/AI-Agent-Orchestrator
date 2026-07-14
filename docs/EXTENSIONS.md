# Local extensions

Forgeboard's extension foundation is local, declarative, versioned, and deny-by-default. It supports
two contribution types:

- validated local agent-adapter manifests; and
- canvas node types assembled from Forgeboard-owned fields, ports, icons, and renderers.

An extension cannot provide renderer JavaScript, HTML, CSS, SVG, a preload, an Electron module, or
an arbitrary Node.js entrypoint. Forgeboard parses the extension in its trusted process layer and
passes only validated serializable records to the sandboxed renderer. The renderer never imports or
evaluates an extension file.

## User experience

Installing an extension does not require editing source, JSON, environment variables, or a config
file:

1. Open **Settings → Extensions** and choose **Choose extension folder**. The optional **Choose
   manifest** action supports advanced packages that point directly at `forgeboard-extension.json`.
2. The native OS picker returns the selection only to the trusted main process.
   `LocalExtensionService.planFromSelectedPath` validates it and returns the identity, version,
   contributions, exact requested permissions, optional documentation, and canonical manifest
   and complete snapshot digests without changing installed state.
3. Forgeboard displays that complete plan. The renderer checkbox records review intent only. The
   trusted main process then opens a BrowserWindow-parented system dialog showing the exact ID,
   version, both SHA-256 digests, and every permission. Cancel is the default; no registry mutation
   occurs unless that dialog is approved.
4. Before install or update, the main process stages the exact approval in its trusted SQLite
   ledger. It writes a data-only snapshot under the application data directory and activates the
   ledger record only after the snapshot operation succeeds. An interrupted or mismatched operation
   remains pending and quarantined. The renderer cannot supply a source path, construct an approval,
   choose a registry path, or mark trust active. Pending plans are window-bound, bounded,
   short-lived, and discarded when their window closes.
5. Settings lists active, quarantined, and invalid/tampered entries separately and supports refresh,
   safe-text documentation display, version updates, and typed-confirmation removal. Users never
   need to edit the managed registry or trusted ledger on disk.

The manifest is an extension-author packaging API, not end-user configuration. A future UI builder
may produce the same validated object programmatically. Direct manifest authoring remains an
optional advanced/developer path.

The desktop bridge validates both request and response contracts. Install, update, failed review,
removal, and privacy-purge decisions enter the redacted local audit log. Active extension
contributions are live declarative data: canvas definitions appear in the node palette and agent
manifests appear in adapter detection. They do not add renderer code, and each actual agent launch
still passes through Forgeboard's normal exact launch disclosure and approval flow.

## Live declarative contributions

Forgeboard activates a contribution only when the managed snapshot and an `active` ledger record
exactly match on API version, extension version, canonical manifest digest, complete snapshot
digest, and sorted permission set. A registry folder by itself is never authority. Missing,
pending, revoked, and mismatched records are quarantined and cannot register adapters or node
types.

Trusted agent manifests use their validated namespaced IDs in detection and the normal run service.
Forgeboard resolves the active manifest again immediately before launch, so removing, revoking, or
changing an extension after launch review prevents the process from starting. Provider,
executable, arguments, working directory, environment names, context, permission profile, and
warnings remain visible in the standard run approval dialog.

Trusted canvas node definitions appear alongside built-in templates. Forgeboard creates and renders
the generic node, ports, inspector, and persisted values itself. Text, number, boolean, select,
file-reference, and directory-reference fields use bounded built-in controls. File and folder
references come only from main-owned native pickers and are stored as canonical local paths; users
never type path configuration. Persisted values are normalized against the current field kinds,
ranges, options, length bounds, and reference shape. If an extension is removed or quarantined,
existing nodes keep their safe data projection but become disabled and visibly unavailable.

## Manifest API version 1

The file name is fixed as `forgeboard-extension.json`. Unknown keys are rejected at every level.
Versions use strict Semantic Versioning 2.0.0. Numeric core and prerelease identifiers reject
leading zeroes, prerelease precedence uses ASCII ordering, and build metadata is accepted but does
not affect update precedence.
This small canvas-only example uses only built-in Forgeboard presentation and storage primitives:

```json
{
  "schemaVersion": 1,
  "id": "acme.decisions",
  "name": "Decision notes",
  "version": "1.0.0",
  "description": "Adds a structured decision note.",
  "publisher": "Acme",
  "requestedPermissions": ["canvas.node.register", "canvas.data.persist"],
  "contributes": {
    "agentAdapters": [],
    "canvasNodeTypes": [
      {
        "id": "decision",
        "displayName": "Decision",
        "description": "Records an approved project decision.",
        "category": "Planning",
        "icon": "note",
        "color": "#4F46E5",
        "capabilities": ["context-source", "human-editable"],
        "fields": [
          {
            "id": "summary",
            "kind": "multiline",
            "label": "Summary",
            "required": true,
            "maxLength": 4000
          }
        ],
        "ports": [
          {
            "id": "context",
            "label": "Context",
            "direction": "output",
            "dataType": "context",
            "multiple": true
          }
        ]
      }
    ]
  }
}
```

Canvas node type IDs are local to the extension. Runtime consumers use
`extensionNodeTypeId(extensionId, nodeTypeId)` to create a globally namespaced ID. Adapter IDs must
already start with the extension ID plus a dot. Duplicate fields, ports, adapters, node types, and
capabilities are rejected. Select defaults and numeric ranges are checked before records reach the
renderer.

An optional `documentationFile` may reference a `.md` or `.txt` file inside the selected folder.
Traversal, absolute paths, drive prefixes, empty segments, NUL bytes, oversized files, and symlink
escapes are rejected. Documentation is snapshotted as bounded plain text; a consumer must still use
Forgeboard's safe text or sanitized-Markdown component rather than raw HTML.

Agent contributions embed the stable `AgentAdapterManifestSchema` from
`@forgeboard/agent-adapters`. That schema describes executable-plus-argument-array invocation and
provider disclosure. It does not grant a process launch: each actual run still uses the normal agent
launch preview, permission profile, selected-context policy, and human approval.

## Permissions

Permissions are inferred from contributions. The manifest must request exactly that set: omitting a
required permission and requesting an unused permission both fail validation.

| Permission                    | Meaning                                                              |
| ----------------------------- | -------------------------------------------------------------------- |
| `canvas.node.register`        | Add validated declarative node definitions to the local registry.    |
| `canvas.data.persist`         | Store values for declared fields in the local canvas database.       |
| `agent.adapter.register`      | Add a validated CLI adapter manifest to the local adapter registry.  |
| `agent.process.launch`        | Make that adapter available to the normal approved launch flow.      |
| `agent.context.selected-read` | Allow explicitly selected context to be passed through that adapter. |
| `agent.provider.network`      | Disclose that an adapter's provider may send context off device.     |

There is deliberately no permission for renderer execution, arbitrary filesystem access, shell
execution, unbounded network access, Electron APIs, credentials, or collaboration data. Unknown
permissions are rejected rather than ignored.

## Install and update integrity

`planFromSelectedPath` accepts an absolute user selection, rejects a symlink selection, resolves the
real extension root, uses a fixed manifest name, bounds file sizes, and checks optional resources
with canonical containment. It returns one SHA-256 digest for the fully parsed canonical manifest
and a domain-separated complete snapshot digest covering that manifest plus the exact documentation
text (or its explicit absence).

`install` and `update` require an approval matching the exact extension ID, semantic version,
manifest digest, complete snapshot digest, and least-privilege permission set. Approvals older than
15 minutes or dated more than 60 seconds in the future are rejected. The caller must only create
this approval after an explicit human confirmation; repository text or extension content is never
authority to approve it. Updates require a higher semantic version and a fresh approval.

The registry stores a data-only snapshot with mode-restricted files. Staged directory replacement
prevents partial installs. Discovery does not follow registry symlinks, revalidates each snapshot,
recomputes both digests (including documentation), verifies granted permissions, and reports
invalid/tampered entries without loading them. The desktop manager then reconciles those valid
snapshots with the trusted ledger and exposes only exact active matches. No executable file from the
selected folder is copied into the registry.

Removal revokes trust before touching the registry, so a crash cannot leave a removed contribution
active. **Delete all local data** clears pending plans, revokes ledger entries, safely purges the
managed extension registry, removes the ledger records, and then clears the rest of local storage.

## Process-layer usage for contributors

```ts
const service = new LocalExtensionService(extensionRegistryPath);
const plan = await service.planFromSelectedPath(pathChosenInTheUi);

// Only after the UI shows the entire plan and the human confirms it:
const approval = createExtensionApproval(plan, {
  confirmed: true,
  permissions: plan.requestedPermissions,
});
await service.install(plan, approval);
```

Do not expose `LocalExtensionService` directly to a renderer or accept renderer-supplied manifest,
path, permission, or approval fields as proof of human intent. Forgeboard's desktop bridge keeps
planning and mutation in the main process, validates every extension IPC input and output, displays
the trusted plan, and accepts only its opaque plan ID plus an explicit confirmation. Removal and
approval outcomes enter the redacted audit log.
