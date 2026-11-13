# Indexed Linear Annotation Visual Contract

This document protects the indexed linear genome overview. The approved baseline
is the complete GRCh38 assembly—24 chromosomes, exactly 3,088,269,832 bp—with
dense, color-true, shimmer-free annotations at fully zoomed-out levels, mRNA
glyphs retaining CDS/exon children, and CDS chevrons at detail zoom. Standalone
chromosomes are never acceptance evidence.

## Non-Negotiable Visual Rules

- Fully zoomed-out annotations must not shimmer during pan or zoom.
- Tiny annotations must remain detectable without becoming full-pixel-thick
  stripes.
- Source RGB must be preserved. Do not blend annotation colors toward white or
  otherwise change hue to simulate antialiasing.
- Subpixel support is allowed only as stable screen-space support plus coverage
  alpha. The current retained linear shader widens the support to one CSS pixel
  and scales alpha from true projected width.
- CDS/exon children must stay attached to resolved mRNA features. The overview
  cannot use a top-level-only feature subset that drops CDS/exon rows.
- The complete-assembly open path must request exact annotations. `zoomLevel`
  must not be used as a lossy data-fidelity switch.

## Why This Exists

Several optimization attempts caused regressions that ordinary tests missed:

- True subpixel geometry made features phase in and out while panning.
- A hard `1.25px` minimum width made annotations look like thick full-pixel
  bars.
- White blending made blue annotations pale and hue-shifted.
- Overview-only feature fetches removed CDS/exon child rows, which broke mRNA
  feature-level coloring and chevrons.
- Renderer counters and CDP-only checks passed while the live canvas looked
  wrong.

The approved implementation is therefore intentionally specific:

- `retained-linear-feature-layer.ts` and `retained-linear-transcript-layer.ts`
  preserve source RGB in the fragment shader and encode subpixel coverage only
  in alpha.
- `retained-subpixel-aa.ts` owns the numeric policy. Changing its constants or
  composite behavior is a visual contract change.
- `IndexedGenomeViewer.tsx` requests exact feature rows for the initial
  complete-assembly annotation field.
- `LocalIndexedGenomeDataSource.getFeatures()` must return exact rows for a
  range regardless of zoom level.

## Required Guardrails Before Visual Or Performance Changes

Before changing any indexed linear annotation rendering, data fidelity, or
performance behavior, run and preserve evidence from:

```bash
pnpm --dir packages/core/genome-renderer test -- src/renderers/pixi/overview/retained-subpixel-aa.test.ts src/renderers/pixi/overview/retained-linear-feature-vertices.test.ts
pnpm --dir packages/core/genome-data test -- src/local-indexed-genome-data-source.test.ts
pnpm --dir apps/desktop test -- src/features/sequence/components/IndexedGenomeViewer.deferred-load.test.tsx
```

The live visual oracle is mandatory for this failure class. It opens complete
GRCh38 in the Electron app, verifies the exact assembly identity and annotation
readiness, traverses every overview/detail level, captures the composited canvas
as supplemental evidence, checks hue/lightness/ink density and pan shimmer, and
asserts that resolved mRNAs still carry CDS/exon children. Renderer debug
counters or a standalone-chromosome render are not acceptable proof.

If the oracle fails, stop and fix the visual regression before continuing with
performance work. If the oracle passes but a human review says the image is
wrong, the oracle is incomplete and must be strengthened before the change can
continue.
