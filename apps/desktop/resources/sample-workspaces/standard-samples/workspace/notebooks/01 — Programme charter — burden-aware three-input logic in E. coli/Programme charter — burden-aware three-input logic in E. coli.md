# Programme charter — burden-aware three-input logic in E. coli

> **Directive** — Fix the scientific question, the success criteria, and the
> stop conditions before any cloning.

## Question

Can a three-input transcriptional AND gate be operated in E. coli MG1655 across
a full batch growth curve without the host burden collapsing its dynamic range?

Two-input gates are routine. The failure mode we care about appears at three
inputs, where the summed expression load competes with growth and the gate
output becomes a function of physiology rather than of its inputs.

## Success criteria

ON/OFF ratio at least 20-fold at mid-exponential phase for all eight input
states.

That ratio retains at least 60 percent of its mid-exponential value at the onset
of stationary phase.

Specific growth rate of the fully induced state within 20 percent of the
empty-vector control.

## Stop conditions

If the two-input precursor cannot clear 20-fold, the three-input build is not
attempted. Adding an input cannot repair a gate that is already marginal.

If burden mitigation costs more than half the dynamic range, the architecture is
rejected rather than tuned further.

## Reference material

The part inventory is drawn from the CIDAR MoClo kit. Characterised composite
controls:
[pJ02B2Rm control](../../sequences/kits/moclo-cidar/pJ02B2Rm_AE/pJ02B2Rm_AE.gb)
and
[pJ02B2Gm control](../../sequences/kits/moclo-cidar/pJ02B2Gm_AE/pJ02B2Gm_AE.gb).

Assembly backbone chemistry is validated against
[ODC_0001](../../sequences/kits/open-plasmids/ODC_0001/ODC_0001.gb) as a
sequencing control.

## Related entries

- Part inventory and incoming QC
- Two-input AND gate — the precursor gate
