# DNAForge

DNAForge is a desktop application for molecular biology: a sequence editor and
genome browser with cloning and primer design, read alignment, a protein
structure viewer and a lab notebook. Projects are folders on your own disk. It
is an Electron app (`apps/desktop`) with a Python sidecar (`apps/api`) and Rust
helper programs (`tools/`).

This repository is the source of truth for the desktop app, local compute and
portable shared libraries. Contributions target `main`; see
[CONTRIBUTING.md](CONTRIBUTING.md) for local checks and pull requests, and
[MAINTAINING.md](MAINTAINING.md) for the maintainer landing and release process.

For a guided first contribution, follow the [local development exercise](HACKATHON.md).

## Requirements

Install Git, Node.js and the native build tools for your operating system before
running `node start.mjs`. The script helps install uv and Rust where supported,
then installs the project dependencies.

- A Git clone of this repository. The build reads the commit it is built from
  with `git rev-parse HEAD`, so a ZIP download of the source does not build. On
  macOS and Linux the build runs `/usr/bin/git`.
- Node.js at the version in `.nvmrc`, with pnpm at the version in the root
  `package.json` (`corepack enable` selects it).
- [uv](https://docs.astral.sh/uv/), which installs the Python version in
  `apps/api/.python-version` when it is missing.
- A Rust toolchain with `cargo`. On Linux, the desktop helpers build for musl:
  `rustup target add x86_64-unknown-linux-musl` and your distribution's
  `musl-tools` package.

Native build tools are also needed for the Rust helpers and Node native modules:

- macOS: Xcode Command Line Tools, including the C/C++ compiler and linker.
- Windows: [Rust's MSVC prerequisites](https://rust-lang.github.io/rustup/installation/windows-msvc.html),
  including Visual Studio's **Desktop development with C++** workload and a
  Windows SDK, plus Rust from [rustup.rs](https://rustup.rs). Use PowerShell for
  the commands below. The startup script does not install this toolchain.
- Linux: a C/C++ compiler, `make`, and the musl tools. Debian/Ubuntu call these
  packages `build-essential` and `musl-tools`. A graphical desktop and Electron's
  GTK, NSS and audio libraries are needed to open the application.

The first setup downloads dependencies and compiles native helpers. Install the
platform toolchain before starting the development server.

## Build and test from source

The following block uses a macOS or Linux shell. On Windows, use PowerShell
and set the typecheck memory limit with `$env:NODE_OPTIONS="--max-old-space-size=4096"`
before running `pnpm --dir apps/desktop typecheck`. For the Cargo command, use
`cargo build --release --bin dna-indexer --bin dna-process-guardian` on Windows;
the coverage helper is unsupported there. The other commands in this block
also work in PowerShell. Packaging an installer is not documented yet.

```bash
corepack enable
pnpm install --frozen-lockfile

pnpm --dir apps/desktop build
NODE_OPTIONS=--max-old-space-size=4096 pnpm --dir apps/desktop typecheck
pnpm --dir apps/desktop helpers:build
pnpm --dir apps/desktop test
pnpm -r --filter "./packages/**" run --if-present test

cargo build --release --bin dna-indexer --bin dna-coverage

cd apps/api
uv sync --frozen --extra dev
uv run --frozen pytest -q
```

## Run from source

Most people run DNAForge from source with the development server. Install
[Node.js 22](https://nodejs.org), clone this repository with Git, and run one
command from the clone:

```bash
node start.mjs
```

It checks your tools, offers to install uv and Rust for your user if they are
missing, installs the dependencies, sets up the Python sidecar, builds the Rust
helpers, writes the settings file with free ports, and starts the app. The first
start compiles the app before the window is ready, so allow several minutes. Run
the same command to start the app again; finished steps are quick.
`node start.mjs --help` lists its options.

On Windows the command does not install Rust: install it from
[rustup.rs](https://rustup.rs) first. On Linux it asks you to install your
distribution's `musl-tools` package if that is missing.

On Linux distributions that restrict unprivileged user namespaces, including
Ubuntu 24.04, Electron also needs its sandbox helper configured. After setup,
run this once from the repository root, then start the app normally:

```bash
node start.mjs --setup-only
node node_modules/electron/install.js
sudo chown root:root node_modules/electron/dist/chrome-sandbox
sudo chmod 4755 node_modules/electron/dist/chrome-sandbox
node start.mjs
```

Repeat the sandbox setup after reinstalling Electron. Keep sandboxing enabled;
these commands configure Electron's sandbox rather than disabling it.

These are the manual steps for macOS and Linux, if you prefer to run them
yourself:

```bash
corepack enable
pnpm install --frozen-lockfile
(cd apps/api && uv sync --frozen --extra dev)
pnpm --dir apps/desktop helpers:build
cp apps/desktop/.env.local.example apps/desktop/.env.local
pnpm --dir apps/desktop dev
```

In PowerShell, replace `(cd apps/api && uv sync --frozen --extra dev)` with
`Push-Location apps/api; uv sync --frozen --extra dev; Pop-Location`, and use
`Copy-Item apps/desktop/.env.local.example apps/desktop/.env.local` to copy the
settings file. `node start.mjs` handles these steps for every platform.

The app starts its Python sidecar from `apps/api/.venv`, and it refuses to start
without the Rust helpers that `helpers:build` produces. The first start compiles
the app before the window appears, so it takes longer than later starts.

The launcher reads its ports from `apps/desktop/.env.local` and stops with
"DESKTOP_DEV_PORT is required" when that file is missing. The example file sets
ports 1420, 1500 and 8000; edit your copy if one of them is in use. A
development run keeps its settings and data in its own profile folder, named
with the suffix `-dev-<port>`, apart from an installed DNAForge.

To check a clone end to end without watching it, run:

```bash
pnpm --dir apps/desktop run check:run-from-source
```

It starts the app the same way, waits until the window has loaded and the
sidecar answers its health check, then stops everything it started. This
repository's CI runs the same command on macOS.

## What a build from source leaves out

This repository builds the community distribution
(`apps/desktop/distribution.json`). Compared with the official installers:

- Sign-in and cloud sync are off in a production build
  (`pnpm --dir apps/desktop build`). A development run does not apply that
  switch.
- The app does not update itself. Build the new version from source.
- In-app feedback and diagnostics uploads are off.
- The list of reference genomes that DNAForge prepares and hosts is empty.
- Automatic annotation is not set up. The app starts the sidecar in offline
  annotation mode, so the sidecar does not download the annotation databases or
  the BLAST+, DIAMOND, Infernal and MAFFT programs, and annotating a plasmid
  does nothing. The sidecar uses them when they are already in its data folder:
  `annotation/` and `tools/` under `~/Library/Application Support/Waypoint` on
  macOS, `%LOCALAPPDATA%\Waypoint` on Windows and `~/.local/share/waypoint` on
  Linux. `apps/api/src/annotation/setup.py` and
  `apps/api/src/annotation/tools.py` list the files it expects. This repository
  has no command that installs them.

On Windows, the source environment omits `pysam`, which does not support native
Windows. Python genomics operations that require pysam/htslib are unavailable
there; use macOS or Linux for Python genomics development that requires it.
Windows builds the Rust indexer and process guardian. The HTSlib-based Rust
coverage helper is also unsupported on native Windows, so BAM/CRAM coverage
development requires macOS or Linux.

## What the app sends

- A build from source contains no analytics or crash-reporting keys, so it sends
  neither. The official build environment supplies them (`POSTHOG_API_KEY` and
  `SENTRY_DSN`).
- Official builds send usage analytics and crash reports according to the
  consent notice the app shows. In the EU, the EEA, the UK and Switzerland, and
  where the app cannot tell the region, they stay off until you agree. Elsewhere
  they are on until you turn them off.
- The official Windows installer reports install progress to DNAForge: the step
  reached, the app version, a random ID for that install attempt and, when the
  installer carries one, a download ID (`apps/desktop/resources/installer.nsh`).
  An installer packaged from this repository does the same unless that script is
  changed.

## Repository layout

| Path            | Contents                                                           |
| --------------- | ------------------------------------------------------------------ |
| `apps/desktop`  | The Electron app: main process, preload and renderer               |
| `apps/api`      | The Python sidecar: alignment, annotation and other analysis       |
| `packages/`     | Libraries the app uses: TypeScript, plus Python annotation         |
| `tools/`        | Rust helpers (indexing, coverage, assembly, rasters); a lint rule  |
| `test-fixtures` | Test data: public reference records, synthetic files, a few others |

`test-fixtures/PROVENANCE.md` records the source and license of each fixture,
and of the sample sequences bundled with the app under
`apps/desktop/resources/sample-workspaces`. Most fixtures are public-domain
reference records, CC0 data or synthetic files. A few are third-party files
under MIT, BSD or CC BY 4.0 terms, and some are published sequences recorded as
facts with their source named and no license asserted. Most of the bundled
sample sequences are OpenMTA parts collections or sequences recorded as facts.

## The name Waypoint

DNAForge was developed under the name Waypoint. That name remains in
identifiers: the package scope (`@waypoint/*`), environment variables
(`WAYPOINT_*`), the sidecar program (`waypoint-api`) and its data folder, and
file and folder names inside projects (`.waypoint/`, `.waypoint-workspace`).
They are kept because saved projects depend on them. They do not refer to a
separate product.

## Contributing and security

See [CONTRIBUTING.md](CONTRIBUTING.md). Everyone taking part follows the
[Code of Conduct](CODE_OF_CONDUCT.md). Report vulnerabilities privately as
described in [SECURITY.md](SECURITY.md), not in public issues.

## License

DNAForge is licensed under the
[GNU General Public License, version 3 only](LICENSE). See [NOTICE](NOTICE) for
copyright and third-party licenses.
