# Coupling a metabolite input to the gate

> **Directive** — Replace one synthetic input with a real metabolite sensor, and
> measure what that costs.

## Design

The arabinose-responsive
[C0080 (AraC)](../../sequences/kits/moclo-cidar/C0080_CD/C0080_CD.gb) and its
promoter replace the third synthetic input. LuxR is retained on the second
input, which is why the entry-13 swap was deferred.

## Why this is the honest test

A gate driven by three orthogonal synthetic inducers is a demonstration. A gate
driven by a metabolite the host also metabolises is the actual application, and
it is strictly harder: the input concentration changes during the experiment
because the cells consume it.

## Result

ON/OFF falls to 11-fold, below criterion. The loss is not crosstalk — it is
input depletion: arabinose is consumed within 90 minutes, so the ON state decays
during the measurement window.

## Consequence

A non-metabolisable analogue, or an arabinose-catabolism-deficient host, is
required. Recorded as the primary open problem in entry 18.

## Related entries

- Orthogonality screen — locating the (1,1,0) leak
- Plasmid retention and functional stability over 100 generations
- Synthesis, open problems, and the next design cycle
