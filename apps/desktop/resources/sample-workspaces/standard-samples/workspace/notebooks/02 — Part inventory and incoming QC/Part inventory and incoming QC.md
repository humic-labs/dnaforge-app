# Part inventory and incoming QC

> **Directive** — Establish that every part is the sequence it claims to be,
> before it enters an assembly.

## Why this is entry 02 and not an appendix

Every downstream measurement inherits the identity of these parts. A mislabelled
RBS does not fail loudly; it produces a clean, reproducible, wrong number, and
the error is only discovered when a model stops fitting three months later.

## Promoter ladder

Anderson series, spanning roughly two orders of magnitude:
[J23100 (strong)](../../sequences/kits/moclo-cidar/J23100_AB/J23100_AB.gb),
[J23102](../../sequences/kits/moclo-cidar/J23102_AB/J23102_AB.gb),
[J23106 (medium)](../../sequences/kits/moclo-cidar/J23106_AB/J23106_AB.gb),
[J23107](../../sequences/kits/moclo-cidar/J23107_AB/J23107_AB.gb),
[J23116 (weak)](../../sequences/kits/moclo-cidar/J23116_AB/J23116_AB.gb).

The published relative strengths are used as priors only. They were measured in
a different host and a different backbone, so they are re-measured in entry 03.

## Translation initiation

Monocistronic RBS ladder:
[B0032m (weak RBS)](../../sequences/kits/moclo-cidar/B0032m_BC/B0032m_BC.gb),
[B0033m](../../sequences/kits/moclo-cidar/B0033m_BC/B0033m_BC.gb),
[B0034m (strong RBS)](../../sequences/kits/moclo-cidar/B0034m_BC/B0034m_BC.gb).

Bicistronic designs [BCD2](../../sequences/kits/moclo-cidar/BCD2_BC/BCD2_BC.gb)
and [BCD12](../../sequences/kits/moclo-cidar/BCD12_BC/BCD12_BC.gb) are held in
reserve for entry 14, where context-independence matters more than absolute
strength.

## Reporters and regulators

Reporters:
[E1010m (mRFP)](../../sequences/kits/moclo-cidar/E1010m_CD/E1010m_CD.gb),
[E0040m (GFP)](../../sequences/kits/moclo-cidar/E0040m_CD/E0040m_CD.gb),
[eBFP2](../../sequences/kits/moclo-cidar/eBFP2_CD/eBFP2_CD.gb). Spectrally
separable, so a three-colour readout is possible without deconvolution.

Regulators:
[C0012m (LacI)](../../sequences/kits/moclo-cidar/C0012m_CD/C0012m_CD.gb),
[C0040 (TetR)](../../sequences/kits/moclo-cidar/C0040_CD/C0040_CD.gb),
[C0062 (LuxR)](../../sequences/kits/moclo-cidar/C0062_CD/C0062_CD.gb),
[C0080 (AraC)](../../sequences/kits/moclo-cidar/C0080_CD/C0080_CD.gb).

## Termination and vectors

Terminator in each required MoClo position:
[B0015 (DE)](../../sequences/kits/moclo-cidar/B0015_DE/B0015_DE.gb),
[B0015 (DF)](../../sequences/kits/moclo-cidar/B0015_DF/B0015_DF.gb),
[B0015 (DG)](../../sequences/kits/moclo-cidar/B0015_DG/B0015_DG.gb),
[B0015 (DH)](../../sequences/kits/moclo-cidar/B0015_DH/B0015_DH.gb).

Destination vectors: [DVA_AE](../../sequences/kits/moclo-cidar/DVA_AE/DVA_AE.gb)
and [DVK_AE](../../sequences/kits/moclo-cidar/DVK_AE/DVK_AE.gb) for single
units; [DVK_EF](../../sequences/kits/moclo-cidar/DVK_EF/DVK_EF.gb) and
[DVK_FG](../../sequences/kits/moclo-cidar/DVK_FG/DVK_FG.gb) for multi-unit
assemblies.

## QC outcome

Every part above was verified by full-plasmid sequencing. Junction reads are the
ones that matter: a correct interior with a scrambled fusion site is the failure
this catches.

## Related entries

- Programme charter — burden-aware three-input logic in E. coli
- Promoter strength re-characterisation in the working backbone
- Bicistronic designs and the RBS context problem
