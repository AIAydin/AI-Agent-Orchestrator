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
   input, paste, resize, back, forward, and reload are forwarded to that real Chrome tab.
5. Sign in—including Google OAuth—inside the node when the site permits it. **Focus Chrome** opens
   the native window for password-manager or OS-level dialogs; **Disconnect** closes it; **Clear
   saved Chrome data** removes its sign-in state.

## Connected-agent access

Agent access remains a separate, default-off permission. Enabling **Let connected agents read this
page** does not grant navigation or input control. A token-scoped peer must also have a direct,
unmuted Context edge to the Preview node, and authorization is checked again for every read.

When authorized, an agent may receive bounded visible text, a sanitized DOM snapshot, or a PNG
screenshot from the connected Chrome tab. Form values, checked state, scripts, styles, and console
logs are excluded. Changing the Preview address revokes the node's sharing opt-in and requires fresh
consent.

## Main-process composition

- `browser-companion/contracts.ts` defines validated IPC inputs and bounded outputs.
- `chrome-executable.ts` locates Google Chrome on macOS, Windows, and Linux.
- `cdp-pipe.ts` implements null-delimited Chrome DevTools Protocol messages over child-process file
  descriptors 3 and 4.
- `service.ts` owns Chrome lifecycle, profiles, snapshots, read-only agent sources, and privacy
  cleanup. It also restores replaced DevTools sessions and translates validated input into Chrome
  DevTools Protocol events.
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
navigation, HTTPS rejection, snapshots, privacy
reset, origin-bound agent inspection, address classification, external-site non-embedding, and the
loopback-only Electron attachment guard. Repository typecheck, structure checks, and live browser
verification remain part of the release gate.
