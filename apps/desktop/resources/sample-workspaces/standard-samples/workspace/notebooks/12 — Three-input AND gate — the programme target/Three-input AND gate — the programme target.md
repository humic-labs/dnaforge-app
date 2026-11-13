# Three-input AND gate — the programme target

> **Directive** — Build and characterise the target gate across all eight input
> states.

## Architecture

Inputs [R0010 (pLac)](../../sequences/kits/moclo-cidar/R0010_AB/R0010_AB.gb),
[R0040 (pTet)](../../sequences/kits/moclo-cidar/R0040_AB/R0040_AB.gb) and
[R0063 (pLux)](../../sequences/kits/moclo-cidar/R0063_AB/R0063_AB.gb) drive
[C0012m (LacI)](../../sequences/kits/moclo-cidar/C0012m_CD/C0012m_CD.gb),
[C0040 (TetR)](../../sequences/kits/moclo-cidar/C0040_CD/C0040_CD.gb) and
[C0062 (LuxR)](../../sequences/kits/moclo-cidar/C0062_CD/C0062_CD.gb)
respectively. Output
[E1010m (mRFP)](../../sequences/kits/moclo-cidar/E1010m_CD/E1010m_CD.gb) on the
lower-copy [DVK_FG](../../sequences/kits/moclo-cidar/DVK_FG/DVK_FG.gb) chosen in
entry 11.

Units are oriented divergently per the entry-06 rule. Terminators
[B0015 (DF)](../../sequences/kits/moclo-cidar/B0015_DF/B0015_DF.gb),
[B0015 (DG)](../../sequences/kits/moclo-cidar/B0015_DG/B0015_DG.gb) and
[B0015 (DH)](../../sequences/kits/moclo-cidar/B0015_DH/B0015_DH.gb) occupy
distinct MoClo positions so no two units share a fusion site.

## Result

26-fold ON/OFF at mid-exponential, across all eight states. Criterion cleared.

Growth cost 17 percent, inside the 20 percent limit — the linear projection in
entry 10 was pessimistic, as flagged.

## The state that nearly failed

The (1,1,0) state sits 2.4-fold above the true OFF, the largest single-state
leak. Traced in entry 13 to
[C0062 (LuxR)](../../sequences/kits/moclo-cidar/C0062_CD/C0062_CD.gb) crosstalk,
not to read-through.

## Related entries

- Burden mitigation via copy number and marker choice
- Orthogonality screen — locating the (1,1,0) leak
- Synthesis, open problems, and the next design cycle
