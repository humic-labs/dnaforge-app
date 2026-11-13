# Synthesis, open problems, and the next design cycle

> **Directive** — State what was established, what failed, and what the next
> cycle must change.

## Established

A three-input AND gate meeting all three charter criteria: 26-fold ON/OFF, 65
percent retention into stationary phase, 17 percent growth cost. See entries 12
and 16.

Promoter ladders do not transfer between backbones (entry 03), and monocistronic
RBS ladders do not transfer between CDSs (entry 14). Both were assumptions at
the charter stage and both were wrong.

## Failed

Metabolite input coupling, at 11-fold (entry 15). The cause is input depletion,
not circuit design.

Selection-free stability (entry 17), which selects for degraded gates rather
than simply losing them.

## Carried as open

Non-metabolisable arabinose analogue, or a catabolism-deficient host, for the
entry-15 input.

Chromosomal integration, required before any selection-free deployment.

The [C0062 (LuxR)](../../sequences/kits/moclo-cidar/C0062_CD/C0062_CD.gb) to
[R0040 (pTet)](../../sequences/kits/moclo-cidar/R0040_AB/R0040_AB.gb) crosstalk
from entry 13 remains unfixed and is now the largest single leak in the gate.

## What the next cycle changes first

The input, not the gate. Two of the three failures above are input problems, and
the gate itself met every criterion it was given.

## Related entries

- Programme charter — burden-aware three-input logic in E. coli
- Three-input AND gate — the programme target
- Coupling a metabolite input to the gate
- Plasmid retention and functional stability over 100 generations
