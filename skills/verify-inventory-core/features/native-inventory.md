# Native inventory commands

## Sub-features

- Create rooted storage with explicit named positions and distinct empty
  vessels.
- Receive physical stock linked to an eligible scientific record.
- Move, consume, reconcile, quarantine/release and dispose through atomic
  batches.
- Inspect state, history and original operation receipts after reopen.
- Reject invalid placement, cycles, unknown/insufficient quantity, stale
  commands, identity collisions and unauthorized scope without partial effects.

## How to get to it (user POV)

This is a command-core workflow. A native caller submits `inventory.execute`,
`inventory.inspect`, `inventory.operation` or `inventory.history` through the
existing authenticated loopback server. There is no graphical inventory entry
point in this increment.

## Driving it with Vitest and HTTP

Follow the launch and drive commands in [the skill](../SKILL.md).
`inventory-native-acceptance.test.ts` uses real HTTP requests and a durable
temporary SQLite database. Require receive100 uL, move, consume20, reopen and
read80 uL, then retry the same operation and read80 again. Inspect accepted
history and replay parity. Exercise lost acknowledgement, competing revisions,
changed request under the same operation ID, and invalid instance/token/project
access.

## Gotchas

- A named position does not provide plate geometry, stack order or physical fit
  rules.
- An empty vessel differs from stock with unknown quantity and stock with known
  zero.
- Disposal retains historical quantity while releasing placement and blocking
  further use.
- A lost HTTP response leaves the caller uncertain. Retrieve or retry the
  original operation; do not mint another ID.
- Native-core success does not establish GUI, live-agent, cross-device, catalog
  or hardware behavior.
