# Indexed genome format

`tools/dna-indexer` produces the portable indexed genome files consumed by the
desktop application and local Python sidecar. Its Rust source and tests live in
this repository. Format changes must keep this document and the existing
fixtures consistent with the producer and readers.

## Files

An annotated indexed genome contains these files with a common basename:

```text
<name>.fa.gz
<name>.fa.gz.fai
<name>.fa.gz.gzi
<name>.gff3.gz
<name>.gff3.gz.tbi or <name>.gff3.gz.csi
```

The sequence and annotation files use BGZF compression, which permits indexed
random access. Ordinary gzip compression is insufficient. The FASTA index
addresses the uncompressed sequence layout; the gzip index maps it to compressed
blocks. Annotation output carries one coordinate index. Short contigs use TBI;
contigs beyond its coordinate range use CSI.

FASTA-only input has no annotation files. Readers also support existing
uncompressed FASTA and its `.fai` index. Compression does not change sequence
identity or the annotation schema.

## Annotation schema

The current GFF3 schema is version 2. The emitter writes these header lines:

```text
##gff-version 3
##dna-indexer-version <binary version>
##dna-indexer-schema 2
##dna-indexer-topology linear|circular
```

GFF3 coordinates are one-based and inclusive. Annotation records are sorted by
sequence identifier, start and end for indexing. `ID` identifies a logical
feature; `Parent` records its relationship to another feature. Exon and CDS
records use segment rows. `_lane` carries the indexer's
deterministic display-lane assignment.

`gff_emit.rs` owns emitted schema and feature identifiers. `inference.rs` owns
parent inference for input without explicit relationships. An incompatible
format change needs a schema revision and corresponding reader support;
reinterpreting existing indexed files in place is insufficient.

## Errors and warnings

The indexer writes structured diagnostics to standard error, one JSON object per
line. The stable `code` identifies the failure; `message` supplies detail.
`context` is present when additional fields are available.

```json
{
  "level": "error",
  "code": "GENBANK_PARSE_FAILED",
  "message": "Could not parse the input record",
  "context": { "file": "example.gb" }
}
```

| Code | Level | Meaning |
| --- | --- | --- |
| `GENBANK_PARSE_FAILED` | error | The input could not be parsed into a valid record. |
| `OUTPUT_WRITE_FAILED` | error | An output file could not be written. Check the reported path and I/O error. |
| `BGZF_WRITE_FAILED` | error | Blocked gzip encoding or output failed. |
| `UNSUPPORTED_INPUT_FORMAT` | error | The requested input format is not supported by the command. |
| `WORKSPACE_CONTAINMENT_VIOLATION` | error | The requested output is outside the permitted workspace. |
| `INFERENCE_AMBIGUOUS` | warning | A CDS could not be assigned an unambiguous transcript parent. |
| `FEATURE_SKIPPED_EXTERNAL_LOCATION` | warning | A feature refers to another accession whose coordinates cannot be materialized from this record. |

Warnings preserve the diagnostic without converting it into a successful parent
inference or an imported external feature. Consumers must distinguish warning
records from terminal command failure.

`src/error.rs` declares every indexer error and warning code. The existing
`tests/error_codes_documented.rs` tests require all declared codes to appear in
this document. New failure modes must update both the producer and this table.

## Command output

Standard output carries progress and terminal result objects as newline-delimited
JSON. Consumers read the terminal object to determine the produced files and
metadata; a progress event alone does not establish success. Standard error
remains the diagnostic channel.
