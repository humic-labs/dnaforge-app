# Scientific objects

```text
UI / API / file submission
          |
scientific payloads + immutable blob refs
          |
applyScientificBatch
  complete candidate --> scientific relationship validation
          |                       |
    accepted graph           rejected receipt
          |
atomic persistence adapter (desktop integration follows)
```

Pure, browser-safe scientific semantics over `@waypoint/workspace-revisions`.
This package performs no filesystem, SQL, IPC, network or thermodynamic work.

`defineScientificDocument` validates a format-version-1 document and produces
readable deterministic JSON, a payload blob reference and an owned revision
state. Payloads can contain megabase sequences; revision metadata contains
checksums rather than bases. Unknown envelope fields, non-JSON values, invalid
Unicode and malformed coordinates/chemistry anchors reject instead of being
silently discarded. Custom fields and chemistry details are retained.

Three entities are supported: primers, sequences and strains. Primer placement,
calculated binding evidence, strain sequence associations, strain descent and
accepted assemblies are separate records. Coordinates use zero-based half-open
intervals. Circular intervals wrap when end is less than start, matching the
existing primer artifact convention. Evidence names exact input revisions.
Strain assertions distinguish `planned` from `observed`; an observed assertion
requires accepted evidence. This proves provenance, not biological truth.

`scientificHash` covers scientific content, excluding a display name.
`bindingInputHash` additionally ignores sequence feature annotations and base
case, because neither changes base alignment. Molecule type, topology, chemistry
and custom fields still affect binding identity. Saved payloads retain case,
names and annotations. Full immutable revision pins preserve all of them in
history, regardless of calculation freshness.

`createScientificReader` reads current or exact historical records without
consulting open editor tabs or filesystem paths. It verifies blob length/hash,
UTF-8, payload shape, kind and calculation metadata. Missing/corrupt blobs fail
explicitly. A revision belonging to another object cannot satisfy a reference.

`applyScientificBatch` uses the revision engine's atomic batch primitive and
versioned semantic validation. It checks the whole candidate, including links
affected by deletion, exact evidence inputs, coordinate bounds and descent
cycles. Accepted assemblies are immutable; a successor is a new accepted record
with an exact parent pin and the same construct identity. Historical source,
primer and product pins do not follow current edits. Late evidence remains
historically readable and reports stale/unavailable when its current inputs
change/disappear.

This package is an implementation foundation. Desktop persistence, legacy
conversion, file/Git submission, product views and scientific qualification have
separate checkpoints in the  journal. Pure tests do not establish
product workflow acceptance.
