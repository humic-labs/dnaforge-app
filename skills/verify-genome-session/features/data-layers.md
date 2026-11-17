# Saved sequence data layers

## Native source owner

An existing saved sequence can receive a project-owned CSV layer through the
sequence_data_layers command. The owner retains the CSV snapshot, exact sequence
revision, mapping recipe, every row outcome and presentation in a .dnalayer.json
artifact. The ordinary viewer discovers it through its existing Tracks control.

## Workflow

Create a project using Manage projects → New project. Open a GenBank sequence
through the native file tree. Supply a CSV with explicit numeric sample columns
and either declared position conventions or stable annotation identifiers (id,
locus_tag or ID). Use sequence_data_layers to inspect, prepare and create the
layer against that exact sequence. Require all rows to map under the reject
policy. Explicit exclusion must retain each unmapped, ambiguous and rejected
outcome in the saved artifact.

In the ordinary viewer's Tracks popover, show the saved layer. Change sample,
palette and geometry through that row's gear. Show another layer and require
independent visibility and remembered styles. Use the normal topology and camera
controls. In the untransformed linear map, click a real mark and require normal
sequence selection at its source interval.

Close and reopen the sequence from the native file tree. Require the original
selected layers, values and presentation. Modify the original CSV and reopen
again; the saved snapshot must stay unchanged. Retry identical creation and
require reuse of the original publication. A later human visibility or style
change must survive completion of an earlier agent request.

Inspect or list the saved layer to obtain its exact source reference,
measurement columns and units. Create a binding on a second sequence with csv
kind layer and that source reference. Change only the mapping and presentation.
Require the same retained CSV fingerprint and measurements, a new exact target
fingerprint, and mapping outcomes in the second sequence's coordinates. Close
and reopen both sequences and require independent selections and styles.
Removing the original target must not invalidate the retained measurements.
Retry the same binding after the original source file is unavailable and require
the existing publication; a different source revision must be refused.

## Evidence

Read the actual native artifact and verify its revision, retained CSV content
hash and exact target identity. Preserve original native screenshots,
timestamped frames, actions and errors. A tool result alone does not prove the
viewer painted it. Calling the real tool with fixed requests does not qualify a
live language model's interpretation of a natural request.

For an indexed view, use a prepared local reference with exact sequence and
annotation identities. Obtain its target ID from track_views references. Inspect
that target, bind the retained CSV version and require full-reference annotation
coordinates. The current native adapter supports contigs up to 6 million bases,
a prepared annotation file up to 32 MiB and at most 100,000 source features. It
must refuse changed identities before reading, without installing a reference.

Use the existing indexed gutter eye and gear to select samples, change geometry
and palette. Indexed compiled annotations retain their own colors; per-feature
dataset recoloring is not supported by their painter. Click a signal mark and
require its exact genomic interval. Save the native Track view, close it and
reopen it from the reference library. Require the same retained layer revision,
sample and style. A changed retained artifact revision must stay unavailable and
must not paint.

Ordinary documents and indexed references have distinct target owners and share
the saved dataset, mapping and drawing contracts. Circular signal geometry,
arbitrary alignment lifting and cross-machine recovery are separate acceptance
paths.

## Scientific examples

Open Dev scenarios and choose RNA · SHAPE and paired bases. Require the ordinary
432-base RNA document, 341 measured reactivities, 91 missing values and three
measured zeros. The separate supplied-model layer has 103 arcs. Each arc joins
the centers of its two source bases; its intervening span is not a measurement.
Hover and click the actual curve, then require the native source interval
selection. Pan and zoom without moving the paired bases. Hide and restore either
layer independently, then close and reopen the document through the file tree.

Open a RegSeq promoter example. Require the supplied 160-base fragment and two
native signal rows for LB and anaerobic measurements. All four fragments and
both conditions use one symmetric signed scale. Change the first row's sample
through its native gear and require unchanged source measurements in the second
row. These fragment coordinates do not claim a chromosome placement.

Open CRISPRi · guide growth effects. Require 820 exact guide placements on
NC_000913.3 and signed growth measurements. Click a visible guide mark and
require its 20-base source interval. Open RegulonDB · binding sites and require
176 sequence-verified intervals through the normal BED admission owner. Site
width describes genomic extent, with no fabricated binding-strength score. Save
and reopen the native indexed Track view to verify admitted source and
presentation continuity.

Open a RegSeq promoter and change its information footprint to Matrix through
the existing gear. Require both supplied conditions as separate rows at the same
160 source coordinates, a shared signed scale and no single-sample selector.
Hover and click a real cell. Require its retained source value and the normal
sequence selection. Close and reopen through the file tree; both matrix rows and
their palette must survive. Repeat with the indexed proteome example and its 22
source conditions, retaining the previous single-sample choice when switching
back from Matrix. Missing cells must remain distinct from measured zeros. Keep
the hover visible across normal repaint and clear it on pointer exit.

Open RNA starts and save its two visible layers. Close and reopen through the
reference library. Require both exact layer IDs, revisions and presentations,
coverage intervals and TSS points. A newly selected layer whose publication has
not yet reached the loaded snapshot must keep session capture opening instead of
crashing or saving a partial layer set.

Open Gyrase cleavage and require the exact author W3110-Mu reference. The three
treatment tracks contain 609 ciprofloxacin, 527 oxolinic-acid and 80 microcin
trusted-site calls in the supplied 500 kb subset. Heights preserve source N3E
signal on one shared scale. Absence from a treatment call set is unreported,
with no invented strand, zero-filled condition or substituted MG1655 coordinate.
