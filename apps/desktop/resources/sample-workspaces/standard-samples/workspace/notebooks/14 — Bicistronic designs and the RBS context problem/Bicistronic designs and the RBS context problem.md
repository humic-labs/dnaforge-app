# Bicistronic designs and the RBS context problem

> **Directive** — Test whether the entry-04 ladder transfers to a different CDS,
> and fix it if it does not.

## The claim under test

Entry 04 measured the RBS ladder against
[E1010m (mRFP)](../../sequences/kits/moclo-cidar/E1010m_CD/E1010m_CD.gb) only,
and flagged that monocistronic RBS strength is a property of the RBS-CDS pair
rather than of the RBS. This entry tests that flag instead of trusting it.

## Design

The same ladder —
[B0032m](../../sequences/kits/moclo-cidar/B0032m_BC/B0032m_BC.gb),
[B0033m](../../sequences/kits/moclo-cidar/B0033m_BC/B0033m_BC.gb),
[B0034m](../../sequences/kits/moclo-cidar/B0034m_BC/B0034m_BC.gb) — re-measured
against [E0040m (GFP)](../../sequences/kits/moclo-cidar/E0040m_CD/E0040m_CD.gb)
and [eBFP2](../../sequences/kits/moclo-cidar/eBFP2_CD/eBFP2_CD.gb). Then
repeated with the bicistronic
[BCD2](../../sequences/kits/moclo-cidar/BCD2_BC/BCD2_BC.gb) and
[BCD12](../../sequences/kits/moclo-cidar/BCD12_BC/BCD12_BC.gb).

## Result

The monocistronic ladder reorders between reporters:
[B0033m](../../sequences/kits/moclo-cidar/B0033m_BC/B0033m_BC.gb) outperforms
[B0034m](../../sequences/kits/moclo-cidar/B0034m_BC/B0034m_BC.gb) with
[eBFP2](../../sequences/kits/moclo-cidar/eBFP2_CD/eBFP2_CD.gb). The ladder is
not a property of the RBS.

The bicistronic designs hold their rank order across all three reporters, within
1.3-fold.

## Consequence

Any future unit whose CDS is not
[E1010m (mRFP)](../../sequences/kits/moclo-cidar/E1010m_CD/E1010m_CD.gb) uses a
bicistronic design. The entry-04 numbers remain valid only for
[E1010m (mRFP)](../../sequences/kits/moclo-cidar/E1010m_CD/E1010m_CD.gb), and
are now annotated as such.

## Related entries

- RBS ladder — moving the tuning burden off the promoter
- Part inventory and incoming QC
- Synthesis, open problems, and the next design cycle
