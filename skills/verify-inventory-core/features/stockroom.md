# Expected deliveries and reorder reporting

## Sub-features

- Record local expected amounts without creating stock or sending a supplier
  order. Expected-line lifecycle remains separate from received progress.
- Match immutable original known receipt amounts, independently of current
  remaining stock. All active allocations share original-component and line
  caps.
- Withdraw matching with a reason; explicitly reopen a closed remainder before
  matching corrections. Closing a remainder does not mark it received.
- Record reorder rules with an explicit action basis and validity coverage
  policy. Display the native exact free subtotal, eligible unknown amounts,
  exclusions and conclusion at one scope, principal, revision and native time.

## User path

Open Inventory and choose **Stockroom**. **Record expected delivery** asks for a
current scientific material and exact positive amount. Supplier may remain
unknown. This local declaration does not attach a purchase-order document or
submit an order.

Each expected line shows its original expected amount, actively matched receipt
amount, unreceived remainder, receipt progress and lifecycle. **Match received
material** offers only compatible identified original known components. It shows
original received, already matched and unmatched amounts. Package grouping,
unknown quantities and unresolved vials cannot establish amount fulfillment.
Current use, transfer, recall, expiry and disposal never undo received progress.

**Record reorder rule** requires both policies explicitly: **Suitable for
reservation** or **Ready for withdrawal**, and current recorded rules or
confirmed current validity for the selected action. Sealed material may support
reservation while its withdrawal is blocked. The native owner classifies
eligibility; callers do not strip blocker codes or infer expiry using a renderer
clock.

A compatible eligible unknown amount is not zero. A sufficient known lower bound
can establish adequate; otherwise eligible unknowns mean needs measurement.
Excluded and other-dimension stock remain visible. Expected quantities never
enter the free-stock subtotal. Timers request new native observations at the
reported boundary and never write inventory statuses.

## Desktop driver

Use `refresh-fixture` to capture exact current v22 native state/history from the
qualified arrival profile, then run:

```sh
node apps/desktop/scripts/inventory-journey.mjs --stage stockroom --fixture /absolute/evidence/current-fixture.json --out /absolute/evidence/stockroom
```

The first workflow records an expected 1 mg line for the first actual arrival,
whose original received amount is 1 mg but current remaining stock is already
900000 ng. It matches the full original 1 mg, then uses another 50 µg and
requires fully-received progress to remain 1000000 ng while current stock drops
to 850000 ng. An explicit reservation/current-recorded-rules reorder rule at 1
ng must use the actual native aggregate and include this eligible remaining
stock; no expected amount enters that aggregate.

Every accepted step immediately writes `NN-stockroom-checkpoint.json`. Preserve
failed captures and use `--stage stockroom-resume` with an exact checkpoint in a
new output directory. It refuses changed state/history and never repeats a
completed intent. A complete native restart uses `--stage stockroom-reopen` and
`stockroom-reopen-fixture.json`, requiring exact saved state/history,
independent original receipt progress and current native report parity.

The first driver covers expectation, original receipt allocation, further use
and one explicit reorder policy. Close/reopen/withdrawal corrections, strict
validity policies, deadline refresh, overflow and whole-count refusal require
their scoped native or actual desktop evidence before claiming those paths
qualified. Cross-device inventory, vendor ordering and package-count fulfillment
remain separate workflows.
