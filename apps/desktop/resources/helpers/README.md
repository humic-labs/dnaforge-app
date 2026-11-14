# Bundled helpers (Contents/Helpers/)

This directory holds **DNAForge-built native binaries** that ship inside the
packaged macOS `.app` at `Contents/Helpers/`.

## Why a separate directory from `resources/binaries/`?

The neighboring `apps/desktop/resources/binaries/` contains upstream pre-signed
binaries (`blastn`, `diamond`, `cmscan`) that we redistribute from NCBI / GitHub
releases. They land at `Contents/Resources/binaries/` in the packaged `.app` and
survive macOS notarization because they were signed by their original publishers
before we touched them.

**Our own binaries** (`dna-indexer`, `dna-coverage`, and the Windows-only
`dna-process-guardian`) are unsigned native executables that we cross-compile.
Mach-O executables cannot live in `Contents/Resources/` per Apple TN2206 — that
location is sealed as data during notarization and unsigned Mach-O inside it can
fail. They must go to a standard code location (`Contents/MacOS/` or
`Contents/Helpers/`), and we use `Contents/Helpers/` so they're namespaced
cleanly away from the main Electron executable.

## What goes here

Platform-suffixed binaries we build ourselves:

```
apps/desktop/resources/helpers/
├── README.md (this file)
├── dna-indexer-aarch64-apple-darwin   (built by `cargo build --release --target aarch64-apple-darwin`)
├── dna-coverage-aarch64-apple-darwin  (built by `cargo build --release --target aarch64-apple-darwin`)
├── dna-indexer-x86_64-apple-darwin       (CI matrix build)
├── dna-coverage-x86_64-apple-darwin      (CI matrix build)
├── dna-indexer-x86_64-unknown-linux-musl (CI matrix build)
├── dna-coverage-x86_64-unknown-linux-musl (CI matrix build)
└── dna-process-guardian-x86_64-pc-windows-msvc.exe (Windows package build)
```

`dna-process-guardian` places the renderer Git-read worker and every descendant
inside a kill-on-close Windows Job Object. An abort or helper crash therefore
cannot leave a Git process behind.

The source directory may contain several host variants. The electron-builder
`afterPack` hook removes foreign variants from the staged `.app/Contents/Helpers`
before codesign. It never deletes from this source directory.

These binaries and `coverage-build-provenance.json` are generated locally and
ignored by Git. Do not add them to a contribution.

## Build locally (current platform only)

From the repository root:

```sh
pnpm --dir apps/desktop helpers:build
```

This builds and copies the helpers for the current platform. Native Windows
builds the indexer and process guardian; the HTSlib-based coverage helper is
supported on macOS and Linux.

## How the sidecar finds these at runtime

The Python sidecar wrapper for each helper resolves binaries in this order:

1. Helper-specific explicit override, e.g. `DNA_INDEXER_PATH` or
   `DNA_COVERAGE_PATH`
2. `DNAFORGE_HELPERS_DIR` from Electron, pointing at packaged
   `<app>/Contents/Helpers/`
3. Dev layout: `<repo>/apps/desktop/resources/helpers/`
4. Cargo output: `<repo>/target/release/<helper>`
5. Runtime tools dir: `<Waypoint data>/tools/<platform>/<helper>`

The platform suffix is appended at lookup time (e.g.
`dna-indexer-aarch64-apple-darwin`) to match what `get_platform_suffix()`
returns from `plannotate.py`.

## Why this matters for notarization

The macOS notarization workflow (`scripts/notarize.cjs`) hardened-runtime-signs
the whole packaged app. Mach-O files in `Contents/Resources/` are treated as
data and don't get re-signed; if they're unsigned, notarization fails. Files in
`Contents/Helpers/` (and `Contents/MacOS/`) are treated as code and get signed
inside-out by the notarization step. Our unsigned `cargo build` output therefore
goes here.
