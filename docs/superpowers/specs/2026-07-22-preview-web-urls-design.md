# Web URLs in the preview node — design (Feature A)

Date: 2026-07-22
Status: Approved (brainstorm), pending implementation plan

First of two: **A — web URLs in the preview node** (this doc). **B — a read-only web MCP** giving connected agents DOM/console/screenshot access to the previewed page is a separate later cycle.

## Goal

A web-preview node can point at an **arbitrary web URL** (e.g. `https://app.staging.com`), not only a local dev-server port. The node's address field accepts either a bare port (localhost dev server, as today) or a full URL (external app). External URLs are **origin-pinned**: the preview loads the site and can't navigate away from its origin, while the guest stays fully hardened.

## Current state (from exploration)

- `WebPreviewNodeSchema` (`packages/core/src/model/domain.ts:355-371`) already has `url: z.string().url().optional()` and `navigationHistory` — but the renderer ignores `url` and synthesizes `http://localhost:${port}/` from a renderer-only `previewPort` (`PreviewNodeFace.tsx:75`, `CanvasNode.tsx:154`).
- Security is **loopback-only in three layers**: `url-policy.ts` (`isLoopbackHost`, `validatedSurfaceUrl`), `webview-security.ts` (`allowedGuestNavigation` + session `onBeforeRequest` filter `isAllowedGuestRequest`), and the guest is force-hardened (`hardenAttachingWebviewPreferences`: no preload, `contextIsolation`, `sandbox`, `webSecurity`, non-persistent partition).
- The main-process `PreviewService` only supervises **dev servers it starts**; a user-entered port/URL is loaded directly by the renderer webview, not proxied.

## Decisions made during brainstorming

- **Address field accepts port OR URL** (the "Port" field becomes an address field). Bare integer → `http://localhost:${port}/` (dev-server mode). Full http/https URL → that URL (external mode).
- **External URLs are origin-pinned** (not a general browser): top-level navigation can't leave the entered origin.
- **In URL mode, cross-origin *subresources* are allowed** (real sites need CDN/font/API loads) while top-level *navigation* stays pinned. **Loopback/dev-server mode keeps the strict loopback-only request filter unchanged.**
- **Guest stays fully hardened in both modes.**
- Persist the entered URL to the existing `url` schema field; `previewPort` stays renderer-side.

## Architecture

### 1. Address input (renderer — `PreviewNodeFace.tsx`)

The header input (`aria-label="Preview port"`, `PreviewNodeFace.tsx:226-250`) becomes an address input (text, `aria-label="Preview address"`) that on commit is classified:

- **Bare port** (matches `/^\d{1,5}$/`, 1–65535 via existing `normalizedPort`): `session.updateNodeData(id, { previewPort: n, url: undefined })`.
- **Full URL** (parses as `http:`/`https:` via `new URL(...)`): `session.updateNodeData(id, { url: parsed.href, previewPort: undefined })`.
- **Empty / invalid**: clear both; show the existing inline error affordance for an unparseable value.

The displayed value is `data.url ?? (previewPort ? String(previewPort) : '')`.

### 2. Source URL (`PreviewNodeFace.tsx:75`)

```
const src = data.url ?? (port === null ? null : `http://localhost:${port}/`);
```
`data.url` (a validated `z.string().url()`) wins; otherwise the loopback synthesis is unchanged.

### 3. Mode-aware UI

A derived `isExternalUrl = data.url !== undefined`.
- External: hide the dev-server **Start/Stop** control (nothing to start) and the auto-port-from-dev-server effect (`:125-143`) does not run / does not overwrite `url`. Reload and the config popover stay.
- Port: dev-server controls behave exactly as today.

### 4. Security — origin-pinning for external URLs (`main/previews`)

The pin model already exists (`did-navigate` pins the origin; later navigation must match). Extend it from loopback-only to "the configured origin":

- **`url-policy.ts`** — add an allowed-origin parameter. `validatedSurfaceUrl(raw, { allowedOrigin })`: still requires http/https and no embedded credentials, but the host check becomes `isLoopbackHost(host) || originMatches(url, allowedOrigin)`. `isAllowedSurfaceRequest` keeps exact protocol/host/port matching against the pinned origin (unchanged logic, now the pinned origin can be non-loopback).
- **`webview-security.ts`**:
  - `allowedGuestNavigation` gains the node's configured origin so `will-navigate`/`will-frame-navigate`/`will-redirect` permit the entered origin (and, once pinned, only it) — **top-level navigation off-origin stays blocked**. `about:blank`/`data:` unchanged. `window.open`/`setWindowOpenHandler` off-origin handoff-to-OS-browser unchanged.
  - Session request filter (`isAllowedGuestRequest` / `hardenGuestSession` `onBeforeRequest`): **mode-dependent.** Loopback mode → unchanged strict loopback-only cancel. **URL mode → allow the guest's subresource requests** (do not cancel cross-origin http(s)/ws(s) subresource loads) so a real site functions; permission handlers still return false and downloads still blocked.
  - `hardenAttachingWebviewPreferences` / `shouldAttachPreviewWebview` unchanged — guest stays preload-less, contextIsolated, sandboxed, webSecurity on, non-persistent partition, in both modes.

**How main learns the origin/mode (the security-critical wiring):** the renderer is the source of truth — it knows `data.url`. When a preview enters URL mode, the renderer registers the configured origin with main **keyed by the preview partition** (`preview:<projectId>:<nodeId>`) via a small IPC (or an extension of the existing preview registration). Main keeps a `partition → allowedOrigin | null` map; `null`/absent = loopback mode. The webview-security handlers (registered per `web-contents-created`) look up the guest's partition in that map to decide: pre-pin navigation allowance (loopback always; the configured origin when set), and the subresource-filter mode (strict loopback cancel when `null`; allow subresources when an external origin is set). This is explicit signaling, not timing-based derivation — so the top-level document request to the external URL is allowed from the first request, not racing the pin. The origin registration is cleared when the node clears its URL or the guest is destroyed.

### 5. Persistence & history

`url` persists via the existing schema field; `navigationHistory` (already `z.array(z.string().url())`) records visited URLs as today. No schema change needed — the fields exist.

## Data flow

Type URL in address field → classified as URL → `updateNodeData({ url, previewPort: undefined })` → `src = data.url` → `PreviewWebview` loads it → main-process security pins the entered origin (nav off-origin blocked, subresources allowed) → guest renders the external app, hardened.

## Error handling

- Unparseable address (not a port, not an http/https URL) → inline error, no update.
- `will-navigate` off the pinned origin → blocked (existing mechanism), off-origin `window.open` → OS-browser handoff with confirm (existing).
- Non-http(s) schemes in the address → rejected by classification.

## Testing

- Address classification: bare port → `previewPort` set, `url` cleared; `https://x` → `url` set, `previewPort` cleared; junk → error, no change; empty → both cleared.
- `src` construction: `url` present → used; else port synthesis; neither → null.
- Mode UI: external URL hides Start/Stop and suppresses the dev-server auto-port write; port mode keeps them.
- Security unit tests: `validatedSurfaceUrl` accepts loopback always and the configured external origin; `allowedGuestNavigation` permits the pinned external origin and blocks a different origin; URL-mode request filter allows a cross-origin subresource while loopback-mode cancels it; guest hardening (no preload / contextIsolation / sandbox) asserted unchanged for both modes.

## Out of scope

- The web MCP (Feature B) — agents reading the previewed page.
- A general/free-navigation browser (we deliberately keep origin-pinning).
- Proxying or health-checking user-entered external URLs in `PreviewService` (external URLs load directly in the webview, no dev-server supervision).
- Auth/cookie management for external sites beyond what the non-persistent partition gives.
