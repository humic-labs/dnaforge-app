# Native application journeys

## Sub-features

The public runner drives six existing macOS development-app journeys. It does
not represent the private Electron suite or packaged Windows/Linux coverage.

| Journey     | User behavior and persisted outcome                                                                                                                 |
| ----------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| `workspace` | Create and archive projects, refuse removal of the last project, restart the same profile and verify the active project and stored preference.      |
| `track`     | Save, rename, copy and reopen a native Track View through human controls and the existing agent command.                                            |
| `genome`    | Open a small local reference, move and save its viewport, close and reopen with a new native session and the saved range.                           |
| `canvas`    | Open a sequence and text file, edit and save text, split/join panes, close/reopen and restore identities.                                           |
| `chat`      | Send, queue, advance and stop through the composer; inspect native database outcomes. The external provider HTTP boundary supplies fixed responses. |
| `palettes`  | Select and restore restriction enzymes; customize, save and restore a Track View color.                                                             |

## How to get to it (user POV)

Use an isolated macOS checkout with the public README dependencies, Python
sidecar dependencies and Rust helpers already installed. GitHub CI owns the
complete build and these app runs. The runner does not install dependencies,
download genomes or use a paid provider. `ffmpeg` must be installed for the
original interaction videos.

## Driving it with the public CLI

Run one journey per CI job, with a new absolute evidence directory outside both
checkouts. The directory's parent must exist. Keep evidence under the runner's
home directory so the native file owner can open the fixtures.

```sh
node scripts/ci/native-journeys.mjs \
  --root /absolute/product-checkout \
  --source EXACT_PRODUCT_COMMIT \
  --journey workspace \
  --out /absolute/evidence/workspace
```

The runner's own checkout supplies the unchanged control scripts. `--root`
selects the product checkout that is launched and exercised. Baseline and
candidate runs must use the same control checkout, distinct evidence paths and
their respective exact source commits. A failed baseline stays a failed
baseline; the caller decides whether a regression or behavior-preserving
comparison is required.

In CI, the qualification plan pins the protected development control commit.
Receipts retain both that control commit and GitHub's actual workflow revision;
they may differ on a promotion PR. The binder requires each to match the plan.

Doctor runs inside the command. It refuses an already-running app, rejects a
different source commit or modified tracked source, checks the actual native
runtime's checkout and disposable profile, and waits for renderer readiness and
the owned sidecar's health endpoint. Only the three current-host helper binaries
and generated helper build provenance are permitted build outputs; their hashes
are retained in the receipt. Other untracked source fails qualification.

Require command exit zero and `native-journeys.json` with `status: passed`, the
requested `journey`, exact `sourceSha` and `sourceTree`, and the control commit.
Each phase must retain its original receipt, expected steps, screenshots and
video/frame sequence where the driver records interaction. These media checks
validate presence and file formats; the journey's functional assertions decide
behavior. An empty selection, missing result, wrong source, renderer error or
missing original capture fails the command.

The shared recording finalizer writes the receipt after encoding. It orders a
copy of the frames by their capture timestamps, preserves the original arrival
order and files, and records encoding errors separately from functional errors.
A missing recording cannot leave a passing receipt. For an encoding repair, copy
a retained capture into a new evidence directory and drive
`finalizeJourneyRecording` from
`apps/desktop/scripts/lib/native-journey-recording.mjs`. Decode the resulting
video with `ffprobe` and compare its frame count and duration with the capture.
This proves encoding only; the unchanged full journey must still pass in CI.

## Gotchas

- The runner temporarily replaces this checkout's regular `.env.local` file with
  four fresh ports. It refuses linked settings and an existing running app. It
  restores the original bytes after verified cleanup. A cleanup failure retains
  the owned settings so recovery can address the right ports.
- Every journey gets a fresh private automation profile. Only workspace
  restoration restarts that same profile within its journey. The existing
  launcher's ownership checks stop the app; no process-name kill is used. A
  child that exits during ownership inspection is already stopped. Live
  processes with unknown or foreign ownership remain untouched and fail cleanup.
  If a previously verified child loses its working directory during shutdown,
  cleanup waits for confirmed exit within its existing grace period. Only a
  confirmed missing process makes a raced termination signal harmless. A final
  port-release failure records fresh listener identities, liveness, working
  directories, prior ownership verification and TCP acceptance under
  `ELECTRON_DEV_TEARDOWN_INCOMPLETE`. This observation does not retry shutdown
  or change its failure result.
- Workspace transitions require the runner's fresh scenario profile. Setup waits
  for successful sample import, the visible Samples project and no pending
  imports, then observes the existing reconciliation-idle signal for each
  initial project within a separate 60-second setup deadline. It records the
  project identities and wait times, and refuses a visible project-index error
  before changing the project collection. It archives setup projects once and
  verifies exactly one project remains before testing removal refusal. The
  archive assertion retains its five-second deadline. Only the restoration phase
  reuses that profile. Archiving awaits the required confirmation button. The
  receipt retains the requested project and the observed folder, database and
  preference state so a failed removal can be distinguished from a delayed or
  refused operation.
- Canvas, chat and palette reloads use `reloadNativePage` from
  `apps/desktop/scripts/lib/native-journey-readiness.mjs`. Navigation and native
  readiness share one deadline; a new load identity, page readiness and shell
  readiness must all be observed. Original content, document identity, enzyme
  and color persistence assertions still decide whether restoration passed.
  Before, after and failed startup observations remain in the journey receipt.
  Startup diagnostics are separate from the original captured user steps and
  palette observations; their counts and media requirements stay unchanged.
- An explicit scenario request goes through the existing disposable-profile
  owner using that validated automation path. Ordinary automation gains no
  scenario authority. Shared profiles and unmarked profiles containing user data
  are refused; approved profiles can reopen their own persisted data.
- Profiles, fixture data, receipts and original media remain after the owned app
  stops. Upload the complete output directory even on failure. Do not replace
  failed captures with a later passing run. A failed journey also retains the
  current launch's native stdout and stderr when the launcher can verify their
  ownership. Workspace observations include project registration, visible
  notices and renderer warning/error messages. Capture failures remain separate
  from the original journey failure.
- Chat uses a fixed development credential and intercepts Anthropic HTTP in its
  disposable renderer. It establishes queue and persistence behavior, not
  live-model quality.
- The control and product checkouts both need their locked JavaScript
  dependencies. Control scripts resolve Playwright from their own checkout; the
  product launcher resolves Electron and the sidecar from the product.
- Local focused runner controls use
  `node --test scripts/ci/native-journeys.test.mjs`. They do not establish that
  any application journey passed. A live GitHub run and its originals are
  required before making that claim.
