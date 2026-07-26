# Artemis workspace rules

- Treat this repository as a production, local-first desktop product. Preserve user work and never
  substitute mock controls or fake success states for required behavior.
- A normal user must be able to install a release and configure every ordinary feature in the UI.
  Source edits, environment files, JSON manifests, and hand-written config are optional advanced
  paths only.
- Keep every source, test, style, script, workflow, and configuration file at or below 2,000 lines.
  Split earlier at coherent feature, domain, or runtime boundaries; 2,000 lines is a hard ceiling,
  not a design target.
- Prefer small folders organized by feature and responsibility over catch-all files. Keep Electron
  main-process policy, validated shared contracts, preload transport, and renderer presentation in
  separate modules. Maintained folders under apps, packages, scripts, config, docs, and .github may
  contain at most 12 direct hand-written files of any type; create a named feature or domain
  subfolder before adding a thirteenth. Keep only the standard entry files allowlisted by the
  structure gate at the repository root; place everything else in a named subfolder.
- Run `corepack pnpm check:structure` with the normal verification suite. Do not bypass the structure
  gate by minifying files, combining logical lines, or moving hand-written code into generated paths.
- Maintain `IMPLEMENTATION_CHECKLIST.md` as an evidence-backed ledger. Do not mark an item complete
  until its behavior and relevant tests exist in the current tree.
