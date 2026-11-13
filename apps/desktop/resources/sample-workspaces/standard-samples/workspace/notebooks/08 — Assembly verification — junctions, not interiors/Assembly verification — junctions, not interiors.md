# Assembly verification — junctions, not interiors

> **Directive** — Verify the fusion sites specifically, because that is where
> Golden Gate fails and where colony PCR is blind.

## What colony PCR cannot see

A flanking-primer PCR gives a correctly sized band whenever the parts are
present in the right order. It says nothing about whether each 4-base fusion
scar is correct, and a single-base scar error shifts the downstream reading
frame.

## Method

Sanger across all four junctions of the entry-07 product, using primers that sit
in the parts and read INTO the scars. Junction-spanning reads only; interior
reads are not evidence.

[ODC_0001 (run control)](../../sequences/kits/open-plasmids/ODC_0001/ODC_0001.gb)
is included as a sequencing-run control to separate a bad read from a bad
construct.

## Result

All four junctions exact. One clone carried a silent interior single-nucleotide
difference in
[E1010m (mRFP)](../../sequences/kits/moclo-cidar/E1010m_CD/E1010m_CD.gb)
relative to the reference, attributable to the part stock rather than to
assembly, and it was retained as the working clone with the difference recorded.

## Related entries

- Single transcription unit assembly — Golden Gate conditions
- Two-input AND gate — the precursor gate
