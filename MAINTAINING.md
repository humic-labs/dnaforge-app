# Maintaining DNAForge

## Source ownership

Product changes belong in this repository and land on `dev` through pull
requests. Use short-lived branches. Maintainer branches and community forks
follow the same required checks.

When bringing over work started elsewhere, apply the product patch to a branch
based on current `dev`. Preserve contributor attribution and sign-offs. Keep
private credentials, operational records and private Git history out of the
patch. Preserve changes already accepted here; never replace `dev` with an
exported snapshot or force-push it.

## Landing a change

The [public merge policy](docs/ci/merge-policy.md) owns candidate readiness,
test coverage, delivery authority and the protected merge route. Read it before
requesting admission. Its activation status is established by the live rules,
not by this document.

For an external fork, inspect workflow, dependency and install-script changes
before permitting execution. That permission allows the proposed code to run on
a runner; it does not authorize merging. Contributors do not receive write or
merge access by submitting a contribution.

## Releases

Promote an exact selected source from `dev` to `staging`, then from `staging` to
`prod`. Development builds come from `dev`; Stable releases come from `prod`.
Source promotion and installer publication are separate operations. Follow the
[release policy](docs/ci/releases.md) for immutable tags, staged installer
qualification and production rollout.

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
