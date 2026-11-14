# Inventory workspace

## Sub-features

- Select an admitted project and inspect its durable inventory.
- Create a storage hierarchy and inspect its available positions.
- Receive a measured or unknown amount of a registered scientific material.
- Move, use, measure, quarantine, release and dispose physical stock.
- Read accepted operation history and recover an interrupted operation without
  creating another debit.

## How to get to it (user POV)

Open the **Inventory** activity button. Select a project. Use **Add location**
to create storage, then **Receive stock** to place a physical container in a
vacant position. Select a stock row to inspect its details, actions and history.

## Driving it with Playwright and Electron

Use an isolated background app with the task's configured renderer and debug
ports. Verify the runtime profile is `scenario-e2e` and its provenance names
this exact checkout before driving it. Keep captures outside the checkout.

The required first journey is a freezer containing a two-position box. Receive
100 µL into A1 through the form, move the container to A2, and use 20 µL with a
reason. Read 80 µL, the A2 placement and exactly one consumption in history.
Restart the owned application and confirm those values remain. Preserve original
screenshots and interaction video, together with native state, receipts and
history readback.

Use `inventory-button`, `inventory-panel`, `inventory-project-picker`,
`inventory-positions` and `inventory-stock-table` to find the surface. Location
and position cells expose `data-location-id` and `data-position-id`. Stock rows
expose `data-stock-id`. Forms have accessible names **Add location**, **Receive
stock**, **Move container** and **Use stock**.

The controller's focused checks cover lost acknowledgement, confirmed commit
followed by read failure, revision conflict, reload retention and a project
switch during a pending read. These are distinct from the genuine app journey.
The core skill's native HTTP workflow continues to cover receipt recovery
against real SQLite.

## Gotchas

- Unknown quantity differs from a measured zero. A disposed container's last
  recorded amount is historical, not available stock.
- A confirmed commit followed by a failed refresh is a read failure. Never
  submit that consumption again under a new identity.
- An interrupted submission keeps its exact operation ID and request. Check
  status or retry that same request.
- A revision conflict retains the draft but requires inspection of the latest
  inventory before deliberate resubmission.
- A change notification requests a refresh. It is not a receipt for a pending
  operation.
- The verification workspace and scientific material are synthetic. This journey
  does not establish cross-device synchronization, physical freezer fit, barcode
  hardware or robot execution.
