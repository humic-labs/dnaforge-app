# Physical item codes and exact lookup

## Scope

This workflow extends the existing native inventory owner. The desktop and
native journeys below exercise software lookup and binding. Generated symbols,
file export, printing and real scanner compatibility need their own evidence;
code lookup alone establishes none of them.

## Sub-features

- Attach exact namespaced codes to existing storage and movable containers.
- Retire bindings without allowing their exact tuples to identify another item.
- Resolve exact codes within an admitted project and inventory without writes.
- Keep material identities, physical containers and their contents distinct.
- Expose ambiguity, retired matches and current versus last-known location.
- Compare an expected item without a persisted general verification boolean.

## How to get to it (user POV)

Open Inventory and choose a project. **Scan or enter code** opens a focused
field; **Look up** or Enter requests an explicit read. Item details expose
**Codes and labels**, **Attach existing code**, **Check code** and **Retire
code**. Binding and retirement require reasons. A scan never moves or uses an
item; ordinary follow-up actions remain separate.

## Driving it with Playwright and Electron

Use the owned background scenario profile and the catalog journey fixture.

```sh
node apps/desktop/scripts/inventory-journey.mjs --stage item-codes --fixture /absolute/evidence/catalog/catalog-reopen-fixture.json --out /absolute/evidence/item-codes
```

Attach leading-zero codes to stocked/empty containers and a storage item.
Resolve them without stock creation or history/revision changes. Refuse
same-namespace duplicate attachment to another container. Bind the same text
under another namespace and require ambiguity when the namespace is unspecified.
Retire one binding and require ambiguity to include it; exact retired lookup
keeps its historical target and cannot reassign the old tuple.

Require case, leading zeros and spaces to remain exact. Reject unsupported
control characters instead of silently joining lines. Scanner framing may remove
only its explicit trailing terminator. Wrong expected-item checking must not
report a match. A missing item stays missing after lookup; disposal remains
visible. Keep current and last-known paths distinct and all quantities/holds
unchanged. Do not fall back to material substring search or open scanned URLs.

Stop and restart the native app with the same profile, then run:

```sh
node apps/desktop/scripts/inventory-journey.mjs --stage item-code-reopen --fixture /absolute/evidence/item-codes/item-code-reopen-fixture.json --out /absolute/evidence/item-code-reopen
```

Require exact state and complete accepted-history parity, then inspect active
and retired bindings and repeat zero-write resolution. Keep original media,
frames, timestamps, native values and source-bound receipts.

Focused native acceptance separately covers current read-only grants, denied
scope without disclosure, absent inventory with zero writes/events, ambiguity
across namespaces and explicit isolation across inventories, and the original
lost attachment receipt after later retirement. Focused controller checks cover
stale response generations and revision/scope changes. Domain checks cover
immutable binding targets, lifetime tuple collisions, duplicate requests versus
exact operation retries, fixed-well boundaries, atomic rollback and frozen
legacy request/snapshot compatibility.

## Gotchas

- A code is a lookup key, not an access grant or proof of physical observation.
- Material registry IDs do not choose a particular tube.
- Active code, usable stock, available custody and verified hardware are
  independent facts.
- Do not print a local project fallback or profile-path hash as portable
  identity.
- A text input can normalize raw pasted characters before validation; preserve
  exact input and make framing explicit.
