# Install Forgeboard

Forgeboard is intended to be distributed through
[GitHub Releases](https://github.com/AIAydin/AI-Agent-Orchestrator/releases), but this repository is
public and currently has no tags, published end-user release, or installer download. When a
release is published, its installer will be self-contained: end users will not need Node.js, pnpm, an
API key, an environment file, or source-code edits. Check the release notes, source commit, checksums,
and signing status before installing it; do not treat an unpublished local build as an official
release.

## Choose the download

Replace `<version>` with the version shown on the release page.

| System               | Download                                     |
| -------------------- | -------------------------------------------- |
| macOS, Apple Silicon | `Forgeboard-<version>-mac-arm64.dmg`         |
| macOS, Intel         | `Forgeboard-<version>-mac-x64.dmg`           |
| Windows, x64         | `Forgeboard-<version>-windows-x64-setup.exe` |
| Linux, x64 portable  | `Forgeboard-<version>-linux-x86_64.AppImage` |
| Debian/Ubuntu, x64   | `forgeboard_<version>_amd64.deb`             |

The macOS ZIP is an alternative to the DMG. Each build also includes a
`RELEASE-INFO-<platform>-<architecture>.json` file stating its exact source commit and whether the
macOS or Windows binary was unsigned, signed, or signed and notarized.

## Verify the checksum

Download the matching `SHA256SUMS-<platform>-<architecture>.txt` file. Confirm that the SHA-256
shown for the installer matches the locally calculated value before opening it.

macOS:

```bash
shasum -a 256 Forgeboard-<version>-mac-arm64.dmg
grep 'Forgeboard-<version>-mac-arm64.dmg$' SHA256SUMS-darwin-arm64.txt
```

Windows PowerShell:

```powershell
(Get-FileHash .\Forgeboard-<version>-windows-x64-setup.exe -Algorithm SHA256).Hash.ToLower()
Select-String 'Forgeboard-<version>-windows-x64-setup.exe$' .\SHA256SUMS-win32-x64.txt
```

Linux:

```bash
sha256sum Forgeboard-<version>-linux-x86_64.AppImage
grep 'Forgeboard-<version>-linux-x86_64.AppImage$' SHA256SUMS-linux-x64.txt
```

The combined `SHA256SUMS-source-and-installers.txt` file covers every installer, update blockmap,
and corresponding-source archive attached to the release.

## Install and start

- **macOS:** open the DMG and copy `Forgeboard.app` to Applications. The ZIP can be extracted and
  moved there instead.
- **Windows:** open the assisted installer. It defaults to a per-user installation and allows an
  optional destination choice; uninstalling does not intentionally delete Forgeboard's local data.
- **Linux AppImage:** mark it executable with `chmod +x <file>` and open it. No system installation
  is required.
- **Debian/Ubuntu:** run `sudo apt install ./forgeboard_<version>_amd64.deb`.

On first launch, choose **Use safe defaults** or complete the setup wizard. Agent detection,
permissions, worktree location, commands, Git remotes and GitHub CLI selection, Docker,
collaboration, backups, and other ordinary implemented options are configured in the app.
Hand-written configuration remains optional.

Unsigned development builds can trigger macOS Gatekeeper or Windows SmartScreen warnings. Verify
the checksum and `RELEASE-INFO` file first, then use only the operating system's per-app approval if
you trust that build. Never disable operating-system security globally.
