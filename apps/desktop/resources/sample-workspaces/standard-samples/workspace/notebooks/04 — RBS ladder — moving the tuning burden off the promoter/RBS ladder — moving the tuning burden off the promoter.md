# RBS ladder — moving the tuning burden off the promoter

> **Directive** — Recover the dynamic range lost by retiring the weak promoter,
> using translation initiation instead.

## Rationale

Entry 03 showed the promoter ladder is compressed in this backbone. Translation
initiation is the other lever, and it is largely orthogonal to transcription —
so tuning here does not perturb the promoter measurements already banked.

## Design

Reference promoter
[J23106](../../sequences/kits/moclo-cidar/J23106_AB/J23106_AB.gb) fixed. RBS
varied across [B0032m](../../sequences/kits/moclo-cidar/B0032m_BC/B0032m_BC.gb),
[B0033m](../../sequences/kits/moclo-cidar/B0033m_BC/B0033m_BC.gb),
[B0034m](../../sequences/kits/moclo-cidar/B0034m_BC/B0034m_BC.gb). Reporter
[E1010m (mRFP)](../../sequences/kits/moclo-cidar/E1010m_CD/E1010m_CD.gb),
terminator [B0015](../../sequences/kits/moclo-cidar/B0015_DE/B0015_DE.gb),
vector [DVA_AE](../../sequences/kits/moclo-cidar/DVA_AE/DVA_AE.gb).

## Result

The RBS ladder spans 31-fold, against 9-fold for the promoter ladder in the same
backbone. Tuning moves to the RBS for the remainder of the programme.

## Caveat carried forward

These RBSs are monocistronic and therefore context-sensitive: the 5′ UTR formed
with the downstream CDS changes their effective strength. This ladder is only
valid for
[E1010m (mRFP)](../../sequences/kits/moclo-cidar/E1010m_CD/E1010m_CD.gb). Entry
14 addresses it with bicistronic designs.

## Related entries

- Promoter strength re-characterisation in the working backbone
- Three-colour reporter calibration and maturation correction
- Bicistronic designs and the RBS context problem
