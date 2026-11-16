# Development, staging and production

The public application uses `dev`, `staging` and `prod`. The customer release
channel is called **Stable**. There is no separate `stable` branch or promise
to maintain older release lines after their replacement ships.

The executable branch and check policy is
[`.ci/merge-policy.json`](../../.ci/merge-policy.json). Ordinary changes target
`dev`. Promotion selects an exact source revision; it never means taking
whatever happens to be newest when a job starts.

```text
task PR -> development checks + merge queue -> dev
                                                |
                                      broad qualification
                                                |
                                      promotion to staging
                                                |
                                        promotion to prod
                                                |
                                 immutable release source tag
                                                |
                                    build or reuse installers
                                                |
                                 staged installer qualification
                                                |
                                  production release approval
                                                |
                                  controlled public rollout
                                                |
                                   installed update acceptance
                                                |
                                         Stable release
```

## Source promotion

`dev` is the integration branch. Development checks run on each ready PR and
again on the merge queue's combined candidate. Broad tests run after
integration and before promotion. Failed, missing or skipped required results
cannot qualify a promotion. A passing check on another commit is insufficient.

`staging` contains source selected from development for release qualification.
An ordinary staging promotion must include the exact selected development
commit, preserve the target's history and identify the resulting source tree.
Changes made to resolve a promotion conflict require qualification of that new
tree. Advancement of `dev` does not change an existing candidate.

`prod` contains source accepted through staging. Its promotion PR must preserve
the selected staging source and the destination's history. A source merge into
`prod` does not publish installers, update a customer feed or prove a release
is live.

## Installer staging and publication

The staging branch and staged installers are different parts of the release
process. Source qualification permits release preparation. Installer
qualification proves the packaged product, installation, upgrades from the
current production version, data preservation and recovery on every supported
platform.

Release automation binds the public repository, application commit, source
tree, version and installer hashes. Its own control and verification revisions
are separate identities. A controller repair does not silently replace the
application being released.

Build each candidate once, or reuse retained installers whose exact source,
version and qualification are verified. Promote those same files through
installer staging, production approval and controlled rollout. Changing the
packaged bytes creates a new candidate. A publication-only retry preserves the
candidate's identity and original evidence.

The release manifest identifies the exact installers available to customers.
The updater, download page and release record consume that accepted identity.
Branch position, a created tag or one successful platform build alone does not
establish publication. Production acceptance verifies actual downloads and
updates; a failed rollout restores the recorded predecessor.

Official signing and production controls remain on maintainer-controlled
infrastructure. Public source verification requires no signing credentials or
private operational source. Hosted website and API deployment have their own
staging and production path; desktop source promotion does not deploy them.

## Experimental builds and urgent fixes

Experimental builds come from explicitly qualified `dev` snapshots. They use
their own update channel and application data, and cannot silently migrate a
production project beyond the stable application's supported format.

An urgent production fix starts from the production source and proceeds
through explicit staging and production qualification without importing later
development features. Apply the fix to `dev` as well, or record why that
development line is unaffected. A hotfix is not an exemption from qualification
or production publication controls.

Ordinary implementation delivery ends at `dev`. Promoting source and releasing
to customers are separate operations with their own authority. Neither a green
PR nor an implementation request grants production-release authority.
