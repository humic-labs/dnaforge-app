# Contributing

Thank you for helping improve DNAForge.

This is the canonical product repository. Open pull requests against `main`. You
can develop locally and open a pull request without running our hosted CI.

## Before you start

- Search the existing issues first. For a bug, include the DNAForge version,
  your operating system and the steps that reproduce it. Leave out private
  sequences and lab data; a public sequence that shows the problem is enough.
- For a larger change, open an issue to discuss it before writing code.

## Making a change

1. Fork the repository. Clone your fork, add this repository as `upstream`, and
   create a branch from its current `main`:

   ```bash
   git clone https://github.com/YOUR-USERNAME/dnaforge-app.git
   cd dnaforge-app
   git remote add upstream https://github.com/humic-labs/dnaforge-app.git
   git fetch upstream
   git switch -c my-change upstream/main
   ```

2. Follow the README's setup instructions. Make the change and add or update
   tests when behavior changes.
3. Run focused checks for the code you changed when possible:
   - desktop: `pnpm --dir apps/desktop test -- <path to test file>`;
   - packages: `pnpm --filter <package name> test`;
   - sidecar: `cd apps/api && uv run --frozen pytest -q <path to test file>`.
4. Commit with `git commit -s`, push your branch to your fork, and open a pull
   request against `humic-labs/dnaforge-app:main`. Describe the problem, the
   change and how you tested it. If a check could not run, say which one and
   why.

## CI on pull requests

Workflows from all external contributors, including returning contributors, wait
for a maintainer to permit execution. A waiting workflow does not stop you from
opening or updating a pull request. You can run the documented checks locally or
enable GitHub Actions in your own fork.

To run CI in your fork, open its **Actions** tab and enable workflows if GitHub
asks. Select **CI**, click **Run workflow**, choose your contribution branch,
and start the run. That branch must contain the `workflow_dispatch` entry in
`.github/workflows/ci.yml`; update older branches from current `upstream/main`
using the signed-off merge below if the manual option is missing. CI also runs
on pushes to `main` and pull requests in your fork. Running your own hosted CI
is optional: local checks are enough to open an upstream pull request.

Required checks must pass before a maintainer merges the change. Local test
results help assess a contribution; they do not replace those checks. Workflow
permission is separate from an approving pull-request review.

For another contribution, fetch `upstream` again and start a new branch from
`upstream/main`. Keep unrelated changes in separate pull requests.

When a maintainer asks you to bring an existing contribution up to date, run
these commands from that contribution's branch:

```bash
git fetch upstream
git merge --signoff upstream/main
git push origin HEAD
```

The merge commit needs its own sign-off. `--signoff` adds it without rewriting
the branch's existing commits. Resolve any conflicts and rerun the affected
checks before pushing.

## Contributor License Agreement

Every contribution is accepted under the
[Contributor License Agreement](CLA.md). You agree to it by adding a
`Signed-off-by:` line with your name and email to each commit; `git commit -s`
adds it for you. A check on every pull request refuses commits without it.
