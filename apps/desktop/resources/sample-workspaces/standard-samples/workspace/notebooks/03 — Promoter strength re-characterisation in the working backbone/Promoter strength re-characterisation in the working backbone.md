# Promoter strength re-characterisation in the working backbone

> **Directive** — Re-measure the promoter ladder in OUR host and OUR backbone,
> because published strengths do not transfer.

## Design

Each promoter drives
[E1010m (mRFP)](../../sequences/kits/moclo-cidar/E1010m_CD/E1010m_CD.gb) through
the strong RBS
[B0034m](../../sequences/kits/moclo-cidar/B0034m_BC/B0034m_BC.gb), terminated by
[B0015](../../sequences/kits/moclo-cidar/B0015_DE/B0015_DE.gb), in
[DVA_AE](../../sequences/kits/moclo-cidar/DVA_AE/DVA_AE.gb). Only the promoter
varies.

Holding RBS, reporter, terminator and vector constant is what makes the
resulting numbers a promoter ladder rather than five unrelated measurements.

## Controls

Positive:
[pJ02B2Rm control](../../sequences/kits/moclo-cidar/pJ02B2Rm_AE/pJ02B2Rm_AE.gb),
a characterised composite from the same kit.

Negative: [DVA_AE](../../sequences/kits/moclo-cidar/DVA_AE/DVA_AE.gb) with no
transcription unit, to establish the autofluorescence floor. Without it, a weak
promoter is indistinguishable from background.

## Measurement

Plate reader, 96-well, three biological and three technical replicates.
Fluorescence normalised to OD600 and reported at mid-exponential phase.

Absolute units are not claimed. The ladder is internally calibrated and only
ratios are carried forward.

## Result

[J23100](../../sequences/kits/moclo-cidar/J23100_AB/J23100_AB.gb) and
[J23102](../../sequences/kits/moclo-cidar/J23102_AB/J23102_AB.gb) fall within
1.4-fold of each other in this backbone, closer than the published ladder
suggests. [J23116](../../sequences/kits/moclo-cidar/J23116_AB/J23116_AB.gb) sits
only 2.3-fold above the floor, which makes it unsuitable as a logic input.

## Consequence for the programme

[J23106](../../sequences/kits/moclo-cidar/J23106_AB/J23106_AB.gb) is selected as
the reference promoter for all downstream logic.
[J23116](../../sequences/kits/moclo-cidar/J23116_AB/J23116_AB.gb) is retired
from the input set — see entry 04 for the RBS-based tuning that replaces it.

## Related entries

- Part inventory and incoming QC
- RBS ladder — moving the tuning burden off the promoter
- Two-input AND gate — the precursor gate
