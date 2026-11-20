# Maintaining DNAForge

## Source ownership

Product changes belong in this repository and land on `main` through pull
requests. Use short-lived branches. Maintainer branches and community forks
follow the same required checks.

When bringing over work started elsewhere, apply the product patch to a branch
based on current `main`. Preserve contributor attribution and sign-offs. Keep
private credentials, operational records and private Git history out of the
patch. Preserve changes already accepted here; never replace `main` with an
exported snapshot or force-push it.

## Landing a change

1. Read the complete diff, including workflow, dependency and install-script
   changes. For an external fork, do this before permitting its workflows to
   run. Workflow permission allows the proposed code to execute on a runner.
2. Resolve conflicts on the contribution branch with the signed-off merge in
   `CONTRIBUTING.md`. Do not update a branch only to make it current: the merge
   queue tests every pull request combined with current `main`.
3. Require the contributor-agreement, desktop build/typecheck/tests and
   Rust/Python checks to pass on the current contribution. Inspect other failed
   checks too, including the macOS source-start workflow. A previous head's
   result does not qualify a changed contribution.
4. Add the pull request to the merge queue. The queue runs the same required
   checks on it combined with current `main` and the pull requests ahead of it,
   then squash-merges it; each commit message, including its sign-off, is kept
   in the squashed commit. Verify the merged commit and observe the normal
   post-merge CI result. Keep follow-up fixes owned until they land. Do not use
   an administrator bypass to skip required checks.

An approving pull-request review is not a merge requirement. Outside
contributors do not receive write or merge access by submitting a contribution.

## Releases

Create immutable version tags from accepted public commits. Build and qualify
each release from its exact tagged source, and identify that tag in the release
notes. Correct a release with a new version rather than moving an existing tag.

Official signing and deployment use maintainer-controlled infrastructure.
Contributors do not need its credentials for development, tests or pull
requests. A release integration must bind the public repository, commit and
source tree it actually builds; its own control-code revision is a separate
identity.

## Ongoing maintenance

- Triage public issues and reproduce reported failures with shareable data.
- Add regression coverage for behavior fixes and keep local setup instructions
  executable from a clean checkout.
- Process dependency-update proposals through the ordinary landing process.
- Handle vulnerability reports through the private reporting route in
  `SECURITY.md`; keep sensitive details out of public issues and pull requests.
- Maintain release notes, supported-version guidance and fixture attribution
  when those change.
