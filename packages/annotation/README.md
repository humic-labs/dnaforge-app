# DNAForge annotation

`dnaforge-annotation` is the app-independent scientific annotation library and
foreground command. It reads one ordinary FASTA record and writes GFF3 or the
complete validated JSON result. It does not start DNAForge, connect to an
account, or open a database.

Install the distribution and run:

```console
dnaforge-annotate input.fasta \
  --output annotations.gff3 \
  --data-dir /path/to/reference-data \
  --tools-dir /path/to/executables \
  --temp-dir /path/to/temporary-files \
  --threads 1
```

`--format json` writes a lossless `AnnotationResult`. `--receipt receipt.json`
adds a portable record containing the request, result, resource configuration,
run identity, and timestamps. `-` selects standard input or standard output.
Invoke the command once per FASTA file for a shell-managed batch.

The tools directory contains `blastn`, `diamond`, and `cmscan`. The reference
directory uses the existing pLannotate layout: search indexes under `BLAST_dbs/`
and the downloaded `swissprot.csv.gz` detail table at its root. Use
`--database-config` to select a different YAML database manifest. Every tool
path, reference path, temporary path, and thread limit reaches the library
through `AnnotationRuntime`; the package does not discover app state.

BLAST cannot memory-map database indexes through a path containing whitespace.
When a reference path has whitespace, the package creates a temporary,
space-free alias to the existing index parts. Query and output files still use
the configured `temp_dir`. The alias uses that directory when possible and
otherwise uses a space-free system temporary path; on Windows it can use the
directory's verified short path. The command fails clearly if no such path is
available. This alias does not rewrite the reference files.

Python callers use the same synchronous boundary as the managed sidecar:

```python
from dnaforge_annotation import AnnotationRequest, AnnotationRuntime, run_annotation

result = run_annotation(AnnotationRequest(sequence="ACGT", linear=True), runtime)
```

Existing output can be read without running the engine or supplying a receipt:

```python
from dnaforge_annotation.files import read_annotation_output

with open("annotations.gff3", encoding="utf-8") as source:
    result = read_annotation_output(source, format="gff3")
```

The reader accepts the package's result JSON and single-sequence GFF3 format. It
preserves origin-crossing features and rejects incomplete or inconsistent
segments. This is not a general multi-sequence GFF importer. A result file alone
does not establish which input revision was analyzed; a consumer must check its
target and review the proposed annotations before applying them.

The packaged IUPAC complement resource is generated from the repository's
canonical `@waypoint/sequence-utils` package. Refresh or verify it with:

```console
node packages/annotation/scripts/generate-complements.mjs
node packages/annotation/scripts/generate-complements.mjs --check
```
