# Hack on DNAForge

Work on the desktop app, its local Python backend, Rust helpers, or shared
libraries. The hosted website and hosted services remain private. The exercises
below run locally and do not need a DNAForge account or an AI subscription.

## Fork and start

Install Git and Node.js 22. Follow the operating-system prerequisites in
[README.md](README.md), including the native compiler tools. Fork
[humic-labs/dnaforge-app](https://github.com/humic-labs/dnaforge-app) on GitHub,
then run:

```sh
git clone https://github.com/YOUR-USERNAME/dnaforge-app.git
cd dnaforge-app
git remote add upstream https://github.com/humic-labs/dnaforge-app.git
git fetch upstream
git switch -c my-hackathon-change upstream/main
node start.mjs
```

Use a Git clone, rather than a source ZIP. The first start installs dependencies
and compiles native helpers and the app. Allow several minutes and keep the
terminal open. Run the same command again after stopping the app; completed
setup steps are reused.

The app includes a writable copy of **DNAForge Samples**. Your changes to that
copy are local project data, separate from the sample files in your Git
checkout. Cloud sync, hosted AI and automatic annotation are separate from these
exercises; see the README's community-build limitations.

## Check the local editing loop

1. In the Files sidebar, expand **DNAForge Samples → notebooks**.
2. Open **01 — Programme charter — burden-aware three-input logic in E. coli**.
   The first open may take tens of seconds while the app indexes its sample
   project. Wait for the notebook editor before typing.
3. Add a sentence to the notebook. Press **Cmd+S** on macOS or **Ctrl+S** on
   Windows/Linux.
4. Wait until the notebook reports **Saved** and its unsaved-change dot clears.
   Close the notebook tab and open it again. Your sentence should remain.

Next, try a small source edit:

1. Click **Manage projects** above the Files sidebar. Find **New project**.
2. In your code editor, open
   `apps/desktop/src/components/ProjectSwitcherPopover.tsx`.
3. Change `<span>New project</span>` to `<span>Create hackathon project</span>`
   and save the source file. The running app should display the new label.
4. Restore the original text and save. The app should show **New project**
   again.

That temporary edit checks your development setup. Make your actual contribution
on the same branch after restoring it.

Run a focused test from the repository root:

```sh
pnpm --dir apps/desktop test -- src/features/workspace-loader/workspace-projects.test.ts
```

You can check this whole editing loop automatically after stopping your dev app:

```sh
node start.mjs --setup-only
node apps/desktop/scripts/check-contributor-journey.mjs
```

The check uses a fresh app profile, edits its own sample copy, saves and reopens
it, checks a temporary source-label edit, restores that source, runs the focused
test, and stops its app. It writes screenshots, a Playwright trace and a JSON
result under `.evidence/`. Pass an unused output directory as the final argument
to keep the results elsewhere. If FFmpeg is installed, it also produces a video.
On a Linux machine without a display, run the check under `xvfb-run -a`.

## Pick a small contribution

- **Project-picker usability.** Improve a label, keyboard interaction or empty
  state in `apps/desktop/src/components/ProjectSwitcherPopover.tsx`. Its focused
  tests are in `ProjectSwitcherPopover.test.tsx`. Exercise the change in the
  running app and include before/after screenshots for visible changes.
- **Project-list formatting.** Extend a specific case in
  `apps/desktop/src/features/workspace-loader/workspace-projects.ts`, such as a
  relative-time label or display path. Add a case to
  `workspace-projects.test.ts` and run the focused command above.
- **Sequence-library behavior.** Choose one small input/output case in
  `packages/core/sequence-utils/src`, read its adjacent tests, and add a useful
  behavior or regression test. Start with a clearly defined example; preserve
  biological meaning and existing file-format compatibility.

Discuss a larger change with a maintainer before starting. Keep your first PR
small enough that you can explain and demonstrate it during the event.

## Submit the change

Inspect `git diff` and stage only the source, tests and documentation you intend
to contribute. Keep your local project data, settings and credentials out of
Git. Then commit with the required sign-off and push:

```sh
git add PATHS-YOU-CHANGED
git commit -s -m "Describe the improvement"
git push -u origin HEAD
```

Open a pull request against `humic-labs/dnaforge-app:main`. Describe what
changed and which checks you ran. You can open or update a PR before hosted CI
runs. External-contributor workflows wait for a maintainer to permit execution;
a waiting check does not prevent local development or PR submission. Maintainers
run the required checks before merging. See [CONTRIBUTING.md](CONTRIBUTING.md)
for the contributor agreement and instructions for updating a branch.

If setup fails, include your operating system, Node version, the command and the
first relevant error in your issue or PR. Remove tokens and private data from
logs before posting them.
