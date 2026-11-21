# Saved read pileups and annotations

## Sub-features

- Open a saved Track View from Files with the current reference, annotations and
  admitted BAM reads.
- Draw genes and complete read rows across the visible interval, including both
  flanks after panning outside the previous interval.
- Cross between readable rows and the combined read/coverage presentation with
  continuous zoom and pan input.
- Inspect a matching read and a read with a known difference at the same zoom.
- Save As, close and reopen with the same source, annotation selection and
  presentation settings.
- Measure loading, input stalls, bounded tile caches and retained memory across
  repeated equivalent interactions.

## How to get to it (user POV)

Open the project, open Files and double-click its saved Track View. Select mRNA
in the annotation picker. Zoom until individual reads appear, pan away and back,
then zoom out through the read/coverage transition. Use Track view actions, Save
As, close the saved copy and reopen it from Files.

## Driving it with Playwright

Use a task checkout with free configured ports and an owned development profile.
The portable journey starts and stops that checkout's desktop and sidecar:

```sh
PILEUP_PERFORMANCE_OUTPUT="$HOME/DNAForge-proof/pileup-$(date +%Y%m%d-%H%M%S)" \
  pnpm --dir apps/desktop run check:run-from-source
```

It creates a native project with a two-contig annotated reference and 120,000
synthetic reads at approximately 80-fold depth. Fixture admission uses the
production reference and read commands. Saving and reopening use the ordinary
dialogs and Files tree; measured gestures use trusted browser input.

For a running owned preview, read its renderer, debug and API ports from
`apps/desktop/.env.local`. Set the corresponding shell variables and run the
standalone CLI instead of starting another app:

```sh
node apps/desktop/scripts/check-pileup-performance.mjs \
  --debug-port "${DESKTOP_DEBUG_PORT:?Set the owned preview debug port}" \
  --renderer-port "${DESKTOP_DEV_PORT:?Set the owned preview renderer port}" \
  --api-port "${API_PORT:?Set the owned preview API port}" \
  --output "$HOME/DNAForge-proof/pileup-$(date +%Y%m%d-%H%M%S)"
```

Require a passing `pileup-performance-result.json`, complete phase measurements
in `pileup-performance-journey.json`, and the original captures. The running
source and native runtime must match and be clean. Before the opening clock, the
native shell must be ready and its own sidecar health check must pass.

For a slow gesture, compare `lastInputToAllAcknowledgedMs` on the Node clock
with `cadence.wheel.firstTrustedEventMs` and `lastTrustedEventMs`, which are
relative to the existing renderer cadence start. These receipt fields do not
change the clocks or limits used for the result. `cadence.longAnimationFrames`
retains up to eight native frame entries and four script attributions per entry
when the browser supports them. It reports omitted counts and explicit
`unsupported` or `unavailable` status. Script attribution contains only code
filenames, function names and durations; URLs and local file paths are omitted.

Every measured view must show complete, current read geometry without missing
flanks, truncation, stale source data or an unfinished loading indicator. The
selected mRNA track, admitted annotation source, active drawing owner and
committed body must agree. Independently known positive annotation intervals
must have nonzero visible gene geometry and one owner covering the viewport.
Require the saved file to retain its admitted read source and the reopened view
to pass the same checks. Apply the unchanged loading, scheduling, cache and
retained-memory limits in
[the performance contract](../../../docs/pileup-performance.md).

For row layout and read differences, pan a 44 kb view across its previous
boundary and retain the recording through the first fully drawn frame. At a
readable zoom, hover a matching read and one with a known substitution in the
saved alignment. Check each read identifier and the substitution position
against the fixture. Keep the viewport, input and fixture identical for the
before and after captures.

The sidecar’s focused checks exercise both types of reads. From `apps/api` with
its development environment active, run the following command.

```sh
python -m pytest tests/test_alignment_tiles_nucleotides.py tests/test_alignment_tiles_payload_contract.py
```

A full-read tile containing only reference matches retains its read rows and
returns no alternate columns. The guides-only response omits read rows. In a
mixed tile both modes count matching reads toward the depth at a substitution. A
cancelled request must stop before returning a successful result.

## Gotchas

The default portable result covers a fresh saved view of prepared synthetic
data. It does not establish whole-genome loading or physical display cadence.
For the full human reference, follow the same contract's `full-genome` fixture
and native trace instructions. Start a new app process with durable prepared
caches preserved; call this `process-cold-durable-cache-warm`, not an
empty-cache or first-install measurement. Declare the observed 60 Hz or 120 Hz
display and retain original traces bound to the actual renderer surface.

Derive expected transcripts from the actual indexed annotation file before
timing. The supplied query interval must cover every measured viewport. An empty
source interval may have no genes; require at least one independently known
positive phase so a blank annotation track cannot pass the whole journey.
Preparation readiness alone does not prove visible annotation rendering.

Keep failed attempts and original media outside the checkout. Capture motion
when claiming continuous interaction behavior. Garbage collection, screenshots
and detailed read sampling belong outside timed gestures. Fixture admission does
not prove the reference-import UI. Stop only the preview started for this run
with the parent skill's cleanup command; preserve the evidence and saved
workspace.
