# Workspace revisions

This package is DNAForge's pure, server-compatible workspace revision domain. It
defines what a workspace change means without making the filesystem, Git,
SQLite, Postgres, object storage, Electron, or a browser the authority.

```text
desktop / browser / server / agent intent
                    |
                    v
          validated semantic mutation
                    |
          +---------+----------+
          |                    |
       accepted          no-op / conflict / invalid
          |                    |
          v                    v
 immutable records       durable receipt only
          |
 compare-and-set accepted ref
          |
          v
 filesystem, web view, and URL projections

invalid working bytes ---------> isolated recovery candidate
                                      |
                                      +-- never an accepted ref
```

The filesystem remains a complete, ordinary projection that coding agents and
people can inspect and edit. Stable resource IDs and revision IDs describe the
logical history behind those paths; they do not replace paths with opaque files
or require agents to use a database API.

Each workspace version is a small immutable header over two content-addressed
compressed radix maps:

```text
workspace version
      |
      +-- resourceRoot ----------> ResourceId -> revision, path, tombstone
      |
      +-- materializedPathRoot --> portable path -> resource/member owner
```

A one-resource mutation path-copies only the nodes on the changed resource and
path branches. Unchanged subtrees keep their content IDs. The materialized-path
map rejects exact collisions, a file used as an ancestor, and descendants below
a proposed file before either root can become accepted.

## Identity model

| Value                | Meaning                        | Changes when                                                             |
| -------------------- | ------------------------------ | ------------------------------------------------------------------------ |
| `WorkspaceId`        | Stable workspace identity      | Explicit creation creates another workspace                              |
| `RefName`            | Mutable accepted-head name     | The adapter or product defines another named line of work                |
| `ResourceId`         | Stable logical object          | Explicit copy, fork, template, split, or conversion creates a new object |
| `WorkspacePath`      | Current portable locator       | A resource moves or is restored elsewhere                                |
| `ResourceStateHash`  | Exact material state           | File bytes, managed members, or material metadata change                 |
| `ResourceRevisionId` | Immutable logical history node | Material changes, deletion, restore, or explicit revert creates history  |
| `WorkspaceVersionId` | Atomic workspace snapshot      | Accepted membership, path, or resource revision changes                  |
| `OperationId`        | Retry identity                 | A caller starts a new semantic request                                   |

A move changes the workspace version but not the resource revision. An equal
state edit is a receipt-bearing no-op. A revert creates a new revision that
points to the prior state hash; history does not move backward. A tombstone
retains the last path for history but does not reserve that path.

URLs should use stable resource and version IDs as authority. A path may appear
as a readable alias, but it cannot be the durable URL identity because users can
rename or move a resource. Desktop deep links and web routes can therefore
resolve the same resource without forcing the filesystem path to become stable.

Identity and path strings must contain Unicode scalar values; lone UTF-16
surrogates are rejected so UTF-8, URL, desktop, and server encoders cannot alias
or throw on an accepted value. Portable paths use a pinned Unicode full case
fold for collision checks, reject Windows device names including the historical
superscript-digit spellings, limit each component to 255 UTF-8 bytes and 255
UTF-16 code units, and limit the relative path to 1,023 UTF-8 bytes (Darwin's
1,024-byte `PATH_MAX` includes the terminating null). These are format rules,
not host-dependent best effort. Adapters must additionally reject a joined
absolute path when the chosen workspace root consumes the remaining host path
budget.

## Public boundaries

The package deliberately exposes three surfaces:

- `@waypoint/workspace-revisions` contains validated identities, resource-state
  constructors, the mutation reducer, structural merge, inspection, and recovery
  capture.
- `@waypoint/workspace-revisions/codec` imports and exports opaque canonical
  records. Runtime adapters persist these bytes; they do not reconstruct private
  record shapes.
- `@waypoint/workspace-revisions/testing` validates the versioned mutation
  matrix and generated-state seed fixtures. Later filesystem and server adapters
  must consume the same cases rather than silently narrowing them.

The root API keeps `RevisionGraph`, `ResourceState`, and `PublicationPlan`
opaque. Callers cannot construct a trusted resource state, graph, or publication
plan with a cast and then pass it back across the runtime boundary. The codec
accepts canonical bytes only after it checks the envelope limit, record-specific
limit, content ID, record shape, references, graph lineage, and workspace
transition.

Implementation modules import shared contracts from `types.ts` and record shapes
from `graph-records.ts`; only callers import the public `index.ts` barrel.
Keeping that dependency direction explicit prevents the public API from creating
circular runtime or type-import ownership inside the package.

The root API returns a publication capability only for an accepted change:

```text
changed  -> immutable record writes + compare-and-set ref advance
no-op    -> receipt write
conflict -> receipt write
rejected -> receipt write after canonical request admission, otherwise no write
replay   -> no write
recovery -> candidate + receipt writes, no ref advance
operation-ID misuse -> no write; the prior receipt remains authoritative
```

An operation receipt fingerprints the canonical request without its operation
ID. Receipt format version 2 stores enough data to reconstruct the complete
first public result, including record writes and the publication plan. Reusing
an operation ID with equal intent returns that frozen result. Reusing it with
different intent fails before any ref decision. Receipt import rejects outcome
variants that no reducer can produce.

## Mutation and merge behavior

| Intent                              | Resource ID | Resource revision        | Workspace version |
| ----------------------------------- | ----------- | ------------------------ | ----------------- |
| Create                              | New         | New                      | New               |
| Equal-state edit                    | Stable      | Stable                   | Stable            |
| Material edit                       | Stable      | New                      | New               |
| Move                                | Stable      | Stable                   | New               |
| Edit and move                       | Stable      | New                      | New               |
| Remove membership                   | Stable      | Stable                   | New               |
| Delete                              | Stable      | New tombstone            | New               |
| Restore                             | Stable      | New                      | New               |
| Explicit revert                     | Stable      | New, old state reused    | New               |
| Copy/fork/template/split/conversion | New         | New with explicit origin | New               |

Merge is a conservative structural three-way operation. One-sided changes,
identical changes, disjoint resource changes, and edit-on-one-side plus
move-on-the-other compose. Unequal edits, different destinations, delete/edit,
move/delete, membership-removal/edit, duplicate logical creation, and resulting
portable-path collisions remain named conflicts. A divergent successful merge
has two sorted workspace parents and never fabricates a resource revision for a
move. The package computes the unique maximal common ancestor. It rejects a
history with no common ancestor or multiple incomparable maximal ancestors,
including criss-cross ambiguity. There is no hidden last-writer-wins rule.

Canonical import also proves that history could have been produced by the domain
rules. Each stable resource has exactly one zero-parent revision. A one-parent
workspace version may retain a resource revision or advance to its descendant. A
two-parent workspace version must equal the package's structural merge of its
parents. The importer rejects missing objects, cycles, cross-resource parents,
incomplete accepted refs, invalid map trees, and forged transitions.

## Filesystem and server adapters

`applyWorkspaceBatch` accepts a complete ordered set of resource mutations. It
checks the submitted base once, evaluates all resource changes in isolation, and
emits one immutable workspace version, one batch receipt and one accepted ref
advance. Temporary per-resource snapshots never enter its returned graph or
publication. A failure at any position emits a batch failure receipt against the
unchanged original graph. Exact retries work after canonical export/import.

Each resource appears once: callers submit its final intended state rather than
several hidden edits. Every ordered step must satisfy portable-path ownership; a
rename cycle that temporarily occupies another resource's path is currently a
named conflict. Adapters must not silently accept individual mutations as a
fallback. Oversized batch publications are rejected before any accepted write.

A batch may supply a deterministic semantic validator. It sees the complete
candidate before publication; a rejection discards every candidate write and
retains only the failed receipt. Its explicit policy version participates in the
request fingerprint. Exact retries replay the frozen outcome without rerunning
validation. An unavailable validator throws and produces no accepted state.
`inspectResourceState` lets adapters read immutable blob references without
exporting the entire graph.

An adapter is responsible for storage and authorization, not semantics. A
production adapter follows this flow:

1. Validate a request and call the pure reducer.
2. Stage large immutable blobs if the request introduces any.
3. Pass an accepted `PublicationPlan` to `commitPublication` once.
4. In `AtomicPublicationAdapter.commitAtomically`, insert all metadata records
   and compare-and-set the accepted ref in one transaction.
5. Project the accepted version to local files, web views, and URL resolvers.
6. Keep invalid or divergent working data in the recovery-candidate store until
   explicit acceptance or expiry.

If the compare-and-set fails, the adapter returns `ref-mismatch` and exposes
none of the metadata writes. Immutable blob bytes staged before the transaction
may remain as unreachable data. A receipt cannot become durable while its
accepted ref remains at the prior version.

This contract supports desktop and server deployments equally. It preserves
ordinary files for local tools while giving a server stable IDs, atomic
versions, retry safety, and deterministic conflict classification.

The in-memory graph uses persistent indexes for historical states, revisions,
workspace versions, receipts, and recovery candidates. A new graph path-copies
only the changed index branches. A server adapter still scopes reads to one
workspace and the referenced closure. It indexes accepted refs and operation
IDs, stores immutable payloads by content ID, and uses database uniqueness plus
compare-and-set for concurrency. Content addressing deduplicates equal states
without collapsing distinct logical resources.

## Locator contract

Desktop deep links and web routes share the same parsed locator meaning:

- `{ workspaceId }` resolves through the caller-authorized accepted ref.
- `{ workspaceId, versionId }` pins one immutable workspace version.
- `{ workspaceId, resourceId }` resolves the resource at the accepted ref.
- `{ workspaceId, resourceId, revisionId }` pins one immutable resource revision
  and verifies that it belongs to the resource.

Route spelling, authorization, and readable path aliases belong to adapters.
Filesystem paths never authorize a lookup and never replace `ResourceId`.

## Bounded work and hostile-input limits

The package has deterministic structural scale tests. In a workspace with 10,000
resources, one file edit must use at most 128 radix-node reads, 64 new node
writes, and 128 KiB of canonical map-node bytes. A separate 10,000-entry history
test requires each insert to allocate less than 128 KiB. These are structural
limits, not elapsed-time measurements.

Canonical input rejects more than 1 MiB before JSON parsing. A key is limited to
1 KiB, a scalar to 64 KiB, nesting to 100 levels, and the decoded tree to
100,000 nodes. Record-specific limits are stricter where the record shape is
small:

| Record kind                         | Maximum canonical bytes |
| ----------------------------------- | ----------------------: |
| Workspace version                   |                  16 KiB |
| Resource state                      |                 256 KiB |
| Workspace resource or path map node |                 256 KiB |
| Recovery candidate                  |                 256 KiB |
| Resource revision                   |                 512 KiB |
| Operation receipt                   |                   1 MiB |

## Executable red-team contract

`fixtures/mutation-matrix.v1.json` covers local edits, copies, managed-member
changes, deletion and restore, merge conflicts, invalid identity, links, Git
operations, browser/server-agent edits, ownership transfer, recovery, backup
restore, retries, and operation-ID misuse. Every row either executes against the
core or has an explicit adapter/external-authority classification. Unknown,
duplicate, missing, and `skipped` rows fail admission.

`fixtures/state-machine-seeds.v1.json` pins the generated command runs. A
failure prints its minimized command trace and one replay value that contains
both fast-check paths:

```bash
FC_SEED=<seed> FC_PATH='<property-path>|<command-path>' \
  pnpm --filter @waypoint/workspace-revisions test -- state-machine.property.test.ts
```

`fixtures/state-machine-replay-proof.v1.json` records the deliberately planted
failure used to prove that the emitted seed, property path, command path, and
minimized action trace replay exactly. A real property failure also persists
those fields and the replay command to
`test-results/workspace-revisions/state-machine-failure.json` by default; set
`FC_FAILURE_RECEIPT_PATH` to choose another artifact path.

The generated model checks stable ID immutability, move behavior, no-op and
revert semantics, accepted-ref completeness, authority isolation, portable path
validity, parent closure, canonical round trips, exact retries, and recovery
isolation after every command.

## Explicit non-goals

This phase does not implement filesystem watching, stable-file capture, local
Git integration, SQLite or Postgres schemas, object-store I/O, authentication,
authorization, ownership transfer, garbage collection, conflict UI, recovery UI,
biological merge, text merge, CRDTs, or a production caller. Those adapters can
evolve independently without changing the domain contract or the existing DNA
sequence-package disk layout.
