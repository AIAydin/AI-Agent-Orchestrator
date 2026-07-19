# Production marker and control audit

Run `corepack pnpm check:production-controls` to reproduce the static production-source audit. The
command is also part of `corepack pnpm verify`; `corepack pnpm test:quality` exercises the gate with
known-good and known-bad fixtures.

The gate scans hand-written `apps/*/src` and `packages/*/src` source and styles together with
production scripts, tooling configuration, and GitHub workflows. It excludes tests, fixtures,
stories, build output, coverage, packaged releases, and the audit implementation itself (which must
name the forbidden vocabulary in order to detect it). It fails on explicit unfinished work markers
(`TODO`, `FIXME`, `HACK`, and `XXX`), fake/mock-success language, placeholder or stub implementation
language, `not implemented`, and `coming soon`. Ordinary form placeholder text and domain uses such
as template placeholders remain valid.

For JSX/TSX, every native `<button>` must declare `onClick`, `formAction`, or a literal `submit` or
`reset` type. Every native `<a>` must declare `href` or `onClick`. Attribute spreads do not count as
evidence because the audit cannot prove their runtime contents. Missing, nullish, primitive, and
syntactically empty event handlers do not count as actions. JSX parse errors fail the audit.

## Limits and complementary evidence

This is a regression gate, not proof that every product path is complete. Beyond obvious empty
handlers, static syntax cannot show that a referenced handler has meaningful behavior, that a custom
component eventually renders an actionable control, or that a control is reachable and enabled in
every runtime state. Renderer tests and the production-built Electron journeys remain the
authoritative behavioral evidence for those claims.
The marker vocabulary is deliberately narrow to avoid classifying legitimate input placeholders or
domain terminology as unfinished work; code review must still reject evasive wording.

Dependency vulnerability evidence is separate because it depends on current package-registry data.
Run `corepack pnpm audit:production` at the release checkpoint. A passing static audit
does not claim that registry audit is current, and an offline audit result must not be treated as a
clean vulnerability report.
