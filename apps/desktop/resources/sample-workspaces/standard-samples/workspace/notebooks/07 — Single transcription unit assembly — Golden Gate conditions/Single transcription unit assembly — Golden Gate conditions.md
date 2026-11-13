# Single transcription unit assembly — Golden Gate conditions

> **Directive** — Lock the assembly chemistry on the easy case, so a later
> failure is a design failure and not a protocol failure.

## Reaction

BsaI-HFv2 with T4 ligase, 37 C and 16 C cycling, 30 cycles, followed by a 60 C
final digest to linearise unreacted destination vector.

Assembly: [J23106](../../sequences/kits/moclo-cidar/J23106_AB/J23106_AB.gb) plus
[B0034m](../../sequences/kits/moclo-cidar/B0034m_BC/B0034m_BC.gb) plus
[E1010m (mRFP)](../../sequences/kits/moclo-cidar/E1010m_CD/E1010m_CD.gb) plus
[B0015](../../sequences/kits/moclo-cidar/B0015_DE/B0015_DE.gb) into
[DVA_AE](../../sequences/kits/moclo-cidar/DVA_AE/DVA_AE.gb).

## Why the final digest matters

Without it, uncut [DVA_AE](../../sequences/kits/moclo-cidar/DVA_AE/DVA_AE.gb)
carries its own selectable marker and transforms efficiently, producing a
background of white colonies that look like failed assemblies. The digest is the
difference between a 4 percent and a 92 percent correct rate.

## Result

92 percent correct by colony PCR, 12 of 13 colonies. The single incorrect colony
was an empty vector, not a misassembly.

## Conditions frozen

These conditions are now fixed for the programme. Entry 08 verifies the product;
entry 09 uses them for the first real gate.

## Related entries

- Terminator insulation and read-through between adjacent units
- Assembly verification — junctions, not interiors
- Two-input AND gate — the precursor gate
