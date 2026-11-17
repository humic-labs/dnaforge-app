# Shared genome markup

## Ownership

A source-bound markup contract resolves measurements, intervals and appearance
before either viewer renders them. The ordinary sequence viewer and indexed
viewer retain their existing file access, camera, selection and track owners.
Presentation must not modify the underlying annotation document.

## Native controls

For an ordinary sequence, use the existing Tracks popover to show saved data
layers. Open a layer's existing gear for its sample, palette and geometry.
Multiple saved layers can remain visible. Closing and reopening the sequence
must restore visibility and appearance independently for each layer.

For indexed native quantitative tracks, use the existing track gutter checkbox
and gear. Follow [Native genomic projections](native-projections.md) for bars,
heatmap bands, points, native source admission and saved-view restoration.

The former Data sources strip and CSV attachment forms are retired. Do not use
the older standalone viewers or their screenshots as integration evidence.

## Acceptance

Require the same native canvas and renderer across presentation changes. Check
an actual measurement, its source interval and physical selection. Preserve
original captures of the native controls and painted result. The ordinary rut
locus is a 17 kb extraction; its local positions are not whole-reference
positions. Do not compare extracted and indexed positions without the explicit
reference transform.

Ordinary circular signal geometry remains unqualified. Indexed summary rasters
do not establish per-annotation color behavior. A native BigWig sample and an
ordinary saved CSV layer are separate source owners; sharing measurements does
not establish that one saved artifact can already open through both owners.
