# Analytics policy

Shared, fail-closed policy used by DNAForge desktop and web analytics adapters.
It owns consent-v3 resolution, safe PostHog autocapture settings, URL and
SDK-event projection, exact low-cardinality vocabularies, and Electron main
identity-generation validation. Session replay is disabled because rrweb can
serialize arbitrary DOM attributes; masking text and inputs does not cover file
paths or scientific content carried by attributes and `data-*` values. Snapshot
events are also rejected by the shared SDK-event gate.

It does **not** send analytics. Product code sends only through the sanctioned
desktop/web adapters, whose custom event/property policy is generated from
`tools/devops/analytics/registry.json`.

```text
app-owned consent ──resolve──► SDK on/off projection
registry properties ────────► custom-event before-send gate
PostHog SDK event ──deny/sanitize──────► approved egress
renderer identity generation ─validate──► Electron main context
```

Run the focused tests, coverage report, and typecheck with:

```bash
pnpm --filter @waypoint/analytics-policy test
pnpm --filter @waypoint/analytics-policy exec vitest run --coverage
pnpm --filter @waypoint/analytics-policy typecheck
```
