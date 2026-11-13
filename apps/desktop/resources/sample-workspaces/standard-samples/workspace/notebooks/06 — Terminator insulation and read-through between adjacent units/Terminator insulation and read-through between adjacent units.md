# Terminator insulation and read-through between adjacent units

> **Directive** — Quantify transcriptional read-through, because a multi-unit
> gate is only as modular as its terminators.

## Why this must precede assembly

A three-input gate places three transcription units on one plasmid. If unit 1
reads through into unit 2, the gate has an input it was never designed to have —
and it will look like crosstalk, or like a bad fusion site, or like anything
except what it is.

## Design

Tandem reporter construct:
[J23106](../../sequences/kits/moclo-cidar/J23106_AB/J23106_AB.gb) to
[B0034m](../../sequences/kits/moclo-cidar/B0034m_BC/B0034m_BC.gb) to
[E1010m (mRFP)](../../sequences/kits/moclo-cidar/E1010m_CD/E1010m_CD.gb) to the
terminator under test, followed by a promoterless
[E0040m (GFP)](../../sequences/kits/moclo-cidar/E0040m_CD/E0040m_CD.gb). GFP
signal is read-through.

Terminators tested in their MoClo positions:
[B0015 (DE)](../../sequences/kits/moclo-cidar/B0015_DE/B0015_DE.gb),
[B0015 (DF)](../../sequences/kits/moclo-cidar/B0015_DF/B0015_DF.gb),
[B0015 (DG)](../../sequences/kits/moclo-cidar/B0015_DG/B0015_DG.gb),
[B0015 (DH)](../../sequences/kits/moclo-cidar/B0015_DH/B0015_DH.gb).

## Result

Read-through is 2 to 4 percent for all four positions — low, but not zero.
Across three tandem units the compounded leak is enough to lift the OFF state of
a gate by roughly 8 percent.

## Design rule adopted

Transcription units are oriented divergently wherever the vector allows, so
read-through terminates into a non-coding region rather than into the next unit.

## Related entries

- Three-colour reporter calibration and maturation correction
- Single transcription unit assembly — Golden Gate conditions
