# Saved alignment performance

`pnpm --dir apps/desktop run check:run-from-source` starts the real desktop app
and sidecar, then exercises a saved alignment view before stopping its own
stack. The existing source-start CI job runs the same command.

The journey generates a local, indexed BAM containing 120,000 synthetic 150-base
reads at approximately 80-fold depth, plus a two-contig reference. It imports
them through the production admission commands, saves through the dialog,
reopens from Files, pans outside the loaded interval, crosses the read/coverage
transition, and repeats an equivalent warmed interaction cycle. No downloaded
human sequence or private service is needed.

The command prints its evidence directory. Set `PILEUP_PERFORMANCE_OUTPUT` to
choose a directory. Original JSON measurements and screenshots remain there,
including measurements from a failed attempt. The result includes each
requirement and its observed values. All journey callers wait for the native
startup state and task API health before opening a saved view. The report
retains those readiness observations and opening stages; the opening clock still
starts before the file's double click.

## Requirements

| Behavior                                                     | Limit                                                    |
| ------------------------------------------------------------ | -------------------------------------------------------- |
| Saved-view open and reopen                                   | 5,000 ms to complete, current reads                      |
| Pan or zoom settlement                                       | 1,000 ms after the last input                            |
| Animation callback gap or main-thread long task during input | 50 ms                                                    |
| Tile cache                                                   | 192 MiB and 512 entries                                  |
| Retained JavaScript heap growth                              | 64 MiB over at least three equivalent warmed checkpoints |

The settlement and retained-heap values are explicit regression targets. The
heap measurement forces garbage collection outside timed gestures; it is not
peak memory or whole-process memory. Screenshots and detailed row sampling also
run outside timed input.

Every measured viewport must contain reads from the current source generation,
cover the complete visible interval, finish pending reads without errors or
truncation, and show the appropriate read/coverage presentation. Settlement also
requires the current source, request and viewport plan to acknowledge a
presented read view, with the visible track gutter reporting ready. A complete
mesh with a stale or still-loading presentation fails. Offscreen resident halo
tiles remain reported as background preparation; they do not delay completion of
an already complete visible read view. Camera comparisons allow only
floating-point roundoff, bounded by four binary64 representable steps and one
millionth of a base. A fast blank, partially filled, or stale view fails. The
journey checks readable rows near 26.6 kb and an actual blended presentation
near 44 kb, rather than assuming those widths imply the correct presentation on
every canvas.

## Scope of the result

The default `portable-dense` profile measures a fresh saved view of a prepared
synthetic source. It covers loading, completeness, JavaScript scheduling and
retained resources. It does not claim whole-genome loading or physical display
smoothness. Animation callbacks alone cannot establish that a frame reached the
display.

The exported `runPileupPerformanceJourney` accepts a supplied saved fixture and
the `full-genome` profile for the 24-chromosome human reference and a full-sized
alignment file. That profile requires a newly started app with durable prepared
caches preserved, matching source/runtime identities, and Chromium presentation
evidence bound to the actual renderer surface. Missing, ambiguous, partial or
dropped presentation evidence cannot qualify a full-genome result. Native
capture hooks run around the same measured input, with trace serialization after
settlement. Keep original traces alongside the report.

For an already running, isolated desktop preview, the standalone command is:

```sh
node apps/desktop/scripts/check-pileup-performance.mjs \
  --debug-port CDP_PORT --renderer-port APP_PORT --api-port API_PORT \
  --output /absolute/evidence/directory
```

To qualify the full-genome profile, start a new app process, add
`--profile full-genome --fixture /absolute/fixture.json`, and declare the actual
display with `--native-refresh-hz 60` or `120`. The fixture JSON identifies
`savedViewPath`, `workspaceRoot`, `bamPath`, `locusStart`, `readLengthBp`,
`fixtureId`, and `coldScope: "process-cold-durable-cache-warm"`. The saved file
must already be registered and visible in Files. The native adapter retains
compressed original Chromium traces and their surface classifications.

The pure classifier's focused tests are
`apps/desktop/src/features/sequence/pileup-performance.test.ts`. They include
negative controls for slow, missing, stale, truncated and incompletely measured
results. Changing a threshold requires a concrete product decision; do not
adjust a limit merely to make a slow run pass.
