# Native genomic projections

## Entry points

In the background desktop preview, open Dev Scenarios and use one of:

- Expression samples · native tracks.
- Shared genome markup · ordinary sequence.
- Chromosome contacts · native matrix.
- Aligned genomes · native synteny.

Wait for the selected tab and its source to finish opening before interacting.
Close Dev Scenarios using its existing toggle. Capture after its closing
transition ends. Use the existing native sidebar, track gear, coordinate field
and map canvas.

## Expression

The PRECISE-1K example admits 18 native BigWig tracks containing 48 measured
genes per sample. Four tracks start visible. These are 18 conditions from one
dataset. The shared display range is 0–16 published log2 TPM, with smoothing
off.

Open the first track's gear. Change Bars to Heatmap, select Cividis, then change
to Points. Require the same canvas and renderer, unchanged genomic intervals and
values, the correct color legend for Heatmap, and no error after a successful
change. Hide and show a track using its existing checkbox. Hover rutF in sample
p1k_00001 and require approximately 1.009491406, allowing native float32
precision. Its native half-open interval is [1069859, 1070354).

Save through Save view, close its tab, and reopen the saved entry from the
reference library. Require all 18 tracks, visibility, style, palette, scale and
viewport to restore. Read the actual saved file as well as the painted result.

## Existing ordinary sequence

The ordinary example creates a native project, imports and registers the
retained GenBank file, mounts and reconciles it through the normal project
owner, then creates a saved CSV layer. Require 18 samples, seven mapped genes
and 41 retained unmapped rows. Use the existing Tracks popover and layer gear to
choose sample p1k_00003, Color band and Cividis. Close the sequence and reopen
its exact entry from the native file tree. Require the same seven records and
remembered sample, geometry and palette. Presentation changes must not dirty the
sequence document.

## Contacts

The example uses GSM2870426 on the exact U00096.2 reference, 4,639,675 bases.
Its 2,209 cells are 100 kb aggregates of the retained 3C-seq measurements. Do
not relabel this experiment as a different assay or reference build.

Hover and click a cell. Require both genomic intervals and its original value.
The cell [1000000, 1100000) × [1200000, 1300000) has value 2370. Zoom with the
native gesture, then pan horizontally and vertically. Both axes must change.
Save, close and reopen through the reference library. Require the exact source
hash and X/Y camera to survive reference preparation and restoration.

## Gapped comparison

The example compares NC_000913.3, 4,641,652 bases, with NC_004741.1, 4,599,354
bases. It uses 261 retained minimap2 blocks with actual CIGAR operations. The
shared alignment has 3,978,719 display columns; display columns are not genomic
base positions. Unaligned joins are compressed and explicitly represented.

Use the normal zoom gesture repeatedly, with the pointer over the desired
region. Click a real gap and require one biological base and the other genome's
gap boundary. For example, alignment column 16052 maps to target base 16052
(zero based) and a query gap after base 15377. Use the normal coordinate field
to navigate target genomic coordinates. Save, close, and reopen through the
reference library. Require the exact alignment-column camera and source hash.

## Evidence and limits

Preserve original screenshots, timestamped renderer frames, saved documents,
source identities and relevant renderer errors. Use video for zoom, pan and
close/reopen continuity. A source control test or diagnostic count alone does
not qualify the painted app behavior.

With prepared target and query sources bound, zoom across a real gap until both
genomes show nucleotide letters and annotations. Require bounded source windows
whose bases match each exact reference, no whole-genome strings, and no query
bases inside a query-only gap. Pan to load new windows, then save, close and
reopen. Require both source identities and the saved camera to survive. Opening
the Files sidebar can reduce the scale below the existing base-letter threshold;
close it before checking letters at the same camera. Canvas resize can normalize
floating-point coordinates within machine precision.

The native source descriptors retain project ownership and hashes; copying a
saved view to a different computer without its managed source is not qualified.
