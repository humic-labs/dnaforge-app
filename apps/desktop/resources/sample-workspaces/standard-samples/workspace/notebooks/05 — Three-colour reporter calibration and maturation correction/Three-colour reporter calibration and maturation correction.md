# Three-colour reporter calibration and maturation correction

> **Directive** — Make the three reporters comparable, so a colour change is not
> mistaken for an expression change.

## Problem

A three-input gate needs three readouts.
[E1010m (mRFP)](../../sequences/kits/moclo-cidar/E1010m_CD/E1010m_CD.gb),
[E0040m (GFP)](../../sequences/kits/moclo-cidar/E0040m_CD/E0040m_CD.gb) and
[eBFP2](../../sequences/kits/moclo-cidar/eBFP2_CD/eBFP2_CD.gb) differ in
maturation half-life, quantum yield and photostability, so equal protein does
not give equal signal.

## Design

Each reporter is expressed from the identical context —
[J23106](../../sequences/kits/moclo-cidar/J23106_AB/J23106_AB.gb) plus
[B0034m](../../sequences/kits/moclo-cidar/B0034m_BC/B0034m_BC.gb) plus
[B0015](../../sequences/kits/moclo-cidar/B0015_DE/B0015_DE.gb) in
[DVA_AE](../../sequences/kits/moclo-cidar/DVA_AE/DVA_AE.gb) — so the only
variable is the CDS.

## Result

[eBFP2](../../sequences/kits/moclo-cidar/eBFP2_CD/eBFP2_CD.gb) reads 4.1-fold
lower per unit protein than
[E1010m (mRFP)](../../sequences/kits/moclo-cidar/E1010m_CD/E1010m_CD.gb) at 30
minutes, converging to 1.6-fold by 90 minutes. That is maturation, not
expression.

Consequence: all kinetic comparisons use a single reporter. Cross-colour
comparison is only made at steady state, after 120 minutes.

## What this rules out

The apparent "slow arm" seen in early three-colour pilots is a maturation
artefact and not a circuit property. Reported here so it is not rediscovered.

## Related entries

- RBS ladder — moving the tuning burden off the promoter
- Terminator insulation and read-through between adjacent units
