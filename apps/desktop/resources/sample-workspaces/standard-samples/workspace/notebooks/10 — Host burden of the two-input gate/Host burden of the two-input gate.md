# Host burden of the two-input gate

> **Directive** — Measure the growth cost now, so the three-input result can be
> attributed to design rather than to physiology.

## Method

Specific growth rate from OD600 across the exponential window, gate versus empty
[DVK_EF](../../sequences/kits/moclo-cidar/DVK_EF/DVK_EF.gb), four biological
replicates.

Growth rate, not final OD. Final OD conflates rate with yield and is insensitive
to exactly the burden being looked for.

## Result

Fully induced gate grows 14 percent slower than the empty-vector control.
Uninduced is within noise, so the cost is expression, not plasmid maintenance.

## Projection, and why it is only a projection

Naive linear extrapolation puts a three-input gate near 21 percent, just outside
the charter limit. Burden is not linear in expression load, so this is a flag
rather than a prediction — entry 11 tests mitigation before entry 12 spends the
build.

## Related entries

- Two-input AND gate — the precursor gate
- Burden mitigation via copy number and marker choice
- Gate behaviour across the full growth curve
