# Chrome companion for external preview URLs

Date: 2026-07-22
Status: Implemented

## Goal

Web and Mobile Preview nodes accept local development ports and public web addresses without
turning Electron into a general-purpose browser. Local loopback pages stay in Forgeboard's hardened
webview. Public HTTPS pages open in an ordinary, visible Google Chrome window where sign-in,
cookies, password-manager behavior, navigation, and site compatibility work as Chrome intends.

## Security boundary

- External pages never mount in an Electron webview. The renderer and the main-process attachment
  guard both enforce this boundary.
- Forgeboard launches Google Chrome with `--remote-debugging-pipe` and a dedicated per-project,
  per-node `--user-data-dir`. It never opens the user's personal Chrome profile and does not expose a
  TCP debugging port.
- Public addresses must use HTTPS and cannot contain URL credentials. Loopback HTTP remains
  available for local development.
- Chrome cookies and website storage persist only in the dedicated companion profile. Disconnecting
  closes Chrome without deleting that profile; **Clear saved Chrome data** closes Chrome and erases
  it after native confirmation. Forgeboard privacy reset erases every companion profile.
- Forgeboard does not collect Chrome diagnostics or console logs. Chrome pushes bounded compressed
  screencast frames over the private process pipe; Forgeboard acknowledges them immediately and
  transfers each sequence only once. Only validated viewport and user-input events travel back.

## User flow

1. Enter a bare port, a loopback URL, or a public HTTPS address in the Preview address field.
2. Bare ports and loopback URLs render inside the node as before.
3. A public HTTPS address shows a Chrome companion card. **Open in Google Chrome** starts or reuses
   the node's dedicated profile and opens the address in a visible Chrome window.
4. The node becomes an interactive Chrome viewport. Mouse clicks, dragging, scrolling, keyboard
   input, paste, resize, back, forward, and reload are forwarded to that real Chrome tab. Compact
   nodes preserve their exact aspect ratio while using a desktop-sized virtual viewport, so sites
   do not switch to oversized mobile layouts before the frame is scaled into the node.
5. Sign in—including Google OAuth—inside the node when the site permits it. **Focus Chrome** opens
   the native window for password-manager or OS-level dialogs; **Disconnect** closes it; **Clear
   saved Chrome data** removes its sign-in state.

## Connected-agent access

Observation and interaction are separate, default-off node permissions. **Let connected agents
observe this page** shares bounded visible text, a visible-text-only legacy DOM projection, or a PNG
screenshot. It never shares hidden DOM, attributes, form state, URL queries or fragments, scripts,
styles, console output, cookies, storage, or the Chrome debugging transport. **Allow agents to
request browser actions** can only be enabled while observation is enabled. Changing the Preview
address revokes both permissions and requires fresh consent.

A token-scoped peer must also have a direct, unmuted Context edge to the Preview node. Forgeboard
rechecks that edge, both node permissions, the exact Chrome connection, the page origin, and the
page/navigation version on every request and again after an approval prompt. Page controls are
described with short-lived opaque UUID handles created in an isolated Chrome execution world;
agents cannot submit selectors, coordinates, JavaScript, raw DevTools Protocol commands, URLs, or
navigation commands.

Scrolling is bounded and may run without a prompt after interaction is enabled. Every click or text
entry requires a cancel-default native **Allow once** dialog naming the agent, preview, origin, and
control. Password, authentication, payment, file-picker, permission, and popup controls are always
user-only. Downloads are disabled for companion sessions, agent-created popup targets are closed,
typed values are never written to audit events, and stale element handles fail closed. Tool results
label website material as untrusted content so it cannot silently become application authority.

## Main-process composition

- `browser-companion/contracts.ts` defines validated IPC inputs and bounded outputs.
- `chrome-executable.ts` locates Google Chrome on macOS, Windows, and Linux.
- `cdp-pipe.ts` implements null-delimited Chrome DevTools Protocol messages over child-process file
  descriptors 3 and 4.
- `service.ts` owns Chrome lifecycle, profiles, snapshots, bounded agent sources, and privacy
  cleanup. `agent-control/page-scripts.ts` contains the isolated-world element descriptions and
  stable-handle checks. The service restores replaced DevTools sessions and translates only
  validated input into Chrome DevTools Protocol events.
- `agent-peers/preview-control` validates the narrow agent action contracts and owns cancel-default
  native one-time approval. `@forgeboard/peer-mcp` publishes the bounded tools without exposing the
  private Chrome transport.
- `ipc.ts` accepts requests only from the Forgeboard main frame and owns the native destructive-data
  confirmation.
- `ChromeCompanionSurface.tsx` and `useBrowserCompanion.ts` provide the node UI and status polling.

## Failure behavior

- Missing Chrome produces an explicit unavailable state and install message.
- Invalid, credentialed, or insecure public URLs are rejected before Chrome is spawned.
- A closed or failed Chrome process revokes its live agent source.
- Chrome launch and protocol failures appear on the node; they never fall back to an Electron
  external-site webview.

## Verification

Focused coverage exercises private pipe framing and shutdown, dedicated-profile Chrome launch,
session recovery, compressed screencast framing and acknowledgement, viewport and input forwarding,
navigation, HTTPS rejection, snapshots, privacy reset, origin-bound agent inspection, opaque
element handles, stale-page rejection, native action approval, permission reauthorization, blocked
sensitive controls, denied downloads/popups, audit redaction, address classification, external-site
non-embedding, and the loopback-only Electron attachment guard. Repository typecheck, structure
checks, and live browser verification remain part of the release gate.
