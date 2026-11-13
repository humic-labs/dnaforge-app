# Two-input AND gate — the precursor gate

> **Directive** — Clear the 20-fold criterion at two inputs, which the charter
> makes a precondition for attempting three.

## Architecture

Repression-based AND:
[R0010 (pLac)](../../sequences/kits/moclo-cidar/R0010_AB/R0010_AB.gb) and
[R0040 (pTet)](../../sequences/kits/moclo-cidar/R0040_AB/R0040_AB.gb) each drive
a repressor, and the output unit is derepressed only when both inputs are
present.

Regulators
[C0012m (LacI)](../../sequences/kits/moclo-cidar/C0012m_CD/C0012m_CD.gb) and
[C0040 (TetR)](../../sequences/kits/moclo-cidar/C0040_CD/C0040_CD.gb); output
[E1010m (mRFP)](../../sequences/kits/moclo-cidar/E1010m_CD/E1010m_CD.gb) through
[B0034m](../../sequences/kits/moclo-cidar/B0034m_BC/B0034m_BC.gb), terminated by
[B0015](../../sequences/kits/moclo-cidar/B0015_DE/B0015_DE.gb), assembled into
[DVK_EF](../../sequences/kits/moclo-cidar/DVK_EF/DVK_EF.gb).

## Why repression rather than a split activator

A split activator gives a sharper transfer function but needs two well-matched
expression levels. Entry 03 showed the promoter ladder here is compressed, so
matching is unreliable. Repression trades steepness for robustness, which the
charter values more.

## Result

34-fold ON/OFF at mid-exponential. Criterion cleared. The OFF state sits 8
percent above the floor, consistent with the compounded read-through measured in
entry 06 — a prediction that held.

## Gate to the next stage

Charter precondition satisfied. Entry 12 attempts three inputs; entry 10 first
measures what this gate already costs the host.

## Related entries

- Assembly verification — junctions, not interiors
- Host burden of the two-input gate
- Three-input AND gate — the programme target
