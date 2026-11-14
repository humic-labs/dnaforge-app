# Maintaining DNAForge

## Source ownership

Product changes belong in this repository. `main` receives complete features
through pull requests. Maintainer branches and community forks follow the same
required checks.

## Complete-feature integration

For a program delivered through multiple pull requests, create a dedicated
integration branch from `main` and target each implementation pull request at
that branch. Partial implementations must never merge into `main`.

Measure completion against the user's whole assigned outcome, not an individual
child ticket, passing slice, or pull request. Keep the integration branch until
the full feature and its scoped acceptance are complete. Honor any requested
design or scope feedback checkpoint before proceeding past it. Only then
prepare the complete feature for `main`; an implementation request does not
override an explicit feedback or delivery hold.

This changes the integration target, not the required automated checks or
GitHub review rules.

When the owner requests CI at the end of the integration branch, use focused
local checks during construction and keep incremental work out of CI-triggering
pull requests. Run the full required CI on the completed integration candidate.

When bringing over work started elsewhere, apply the product patch to the
feature's integration branch when one exists, otherwise a branch based on
current `main`. Preserve contributor attribution and sign-offs. Keep
private credentials, operational records and private Git history out of the
patch. Preserve changes already accepted here; never replace `main` with an
exported snapshot or force-push it.

## Landing a complete feature on main

1. Read the complete diff, including workflow, dependency and install-script
   changes. For an external fork, do this before permitting its workflows to
   run. Workflow permission allows the proposed code to execute on a runner.
2. Update the branch against current `main` using the signed-off merge in
   `CONTRIBUTING.md`, then wait for its current checks. Resolve conflicts on the
   contribution branch. If `main` advances, check the combined change again
   before merging.
3. Require the contributor-agreement, desktop build/typecheck/tests and
   Rust/Python checks to pass on the current contribution. Inspect other failed
   checks too, including the macOS source-start workflow. A previous head's
   result does not qualify a changed contribution.
4. Merge through GitHub, verify the merged commit and observe the normal
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
