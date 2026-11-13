# Contributing

Thank you for helping improve DNAForge.

## Before you start

- Search the existing issues first. For a bug, include the DNAForge version,
  your operating system and the steps that reproduce it. Leave out private
  sequences and lab data; a public sequence that shows the problem is enough.
- For a larger change, open an issue to discuss it before writing code.

## Making a change

1. Fork the repository and create a branch.
2. Make the change, with a test that fails without it.
3. Run the checks from the README's "Build and test from source" section. At
   minimum, run the tests for the code you changed:
   - desktop: `pnpm --dir apps/desktop test -- <path to test file>`;
   - packages: `pnpm --filter <package name> test`;
   - sidecar: `cd apps/api && uv run --frozen pytest -q <path to test file>`.
4. Open a pull request that describes the problem, the change and how you tested
   it.

## Contributor License Agreement

Every contribution is accepted under the
[Contributor License Agreement](CLA.md). You agree to it by adding a
`Signed-off-by:` line with your name and email to each commit; `git commit -s`
adds it for you. A check on every pull request refuses commits without it.
