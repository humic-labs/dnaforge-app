# Reference preparation manifests

These manifests exercise the public raw-reference preparation contract without
duplicating biological source bytes. `puc19.v1.json` points at the existing
public pUC19 FASTA/GFF3 fixture, pins both source hashes, and is intentionally
small enough to run the complete scene, raster, annotation-search, and
protein-search publication lifecycle during focused integration tests.

The manifest is an input descriptor, not a generated asset. Prepared outputs
belong in the machine-local reference cache and must never be committed here.
