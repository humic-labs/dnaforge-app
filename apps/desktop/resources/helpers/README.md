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

The source directory may contain several host variants. Packaging is
architecture-pure: the electron-builder `afterPack` hook removes every foreign
variant from the staged `.app/Contents/Helpers` before codesign. It never
deletes from this source directory. This matters on x64 builds because the
repository currently carries an arm64 fallback binary; copying both into one app
makes codesign reject the outer bundle.

The repo tracks these via Git LFS for the PR cycle (see `.gitattributes`). At
ship time, the GH Release pipeline takes over: binaries upload to GitHub
Releases under helper-specific tags such as `dna-indexer-v0.1.0` and
`dna-coverage-v0.1.0`, and `scripts/download-binaries.sh` fetches them on
install. LFS becomes the fallback source.

## Build locally (current platform only)

```sh
cd /path/to/waypoint
cargo build --release
# Copy the built binary into this dir with the platform suffix:
TARGET=$(rustc -vV | sed -n 's|host: ||p')
cp target/release/dna-indexer "apps/desktop/resources/helpers/dna-indexer-$TARGET"
cp target/release/dna-coverage "apps/desktop/resources/helpers/dna-coverage-$TARGET"
```

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
