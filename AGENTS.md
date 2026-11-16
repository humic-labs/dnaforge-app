# Working on DNAForge

Read `README.md`, `CONTRIBUTING.md` and `MAINTAINING.md` before changing code.
This repository is the source of truth for product development. Use a feature
branch and open a pull request against `main`.

Run focused checks for the behavior you change. Existing CI owns the complete
builds and test suites. Preserve other contributors' work and keep unrelated
changes separate.

Use the same public commands as other contributors. Development must not depend
on private issue trackers, credentials, Git hooks or release infrastructure.
Never publish private operational data or replace public history with a source
snapshot.

Keep required checks. Do not add rules requiring approving or code-owner
reviews. Verify the actual merged result before reporting delivery.

Use [the public merge policy](docs/ci/merge-policy.md) for delivery authority,
complete-feature readiness and qualification. Keep incomplete or held work in a
draft PR. Use `node scripts/ci/deliver.mjs inspect --pr NUMBER` for the current
read-only decision; a green check alone grants no merge authority.

Before changing a delivery or application workflow, reuse or extend its
verification skill and feature map. The delivery surface is documented in
`skills/verify-public-delivery/SKILL.md`. Preserve real source-bound evidence
outside the checkout; do not substitute a skill file or a passing unit test for
executed workflow acceptance.
