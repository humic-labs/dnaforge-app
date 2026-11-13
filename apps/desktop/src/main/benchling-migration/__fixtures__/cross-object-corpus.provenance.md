#  cross-object corpus provenance

This fixture is deterministic synthetic test data released under CC0-1.0. It
models only the structural facts observed in a controlled Benchling export:

- a notebook entry can link to another notebook entry and to a sequence by
  stable object ID;
- the stable target ID can survive in the notebook URL and exported filename
  while being absent from the GenBank body;
- two sequence exports can have the same display name and identical sequence
  bytes but different stable IDs; and
- import order and identifier loss need explicit expected outcomes.

The fixture does not copy a real tenant slug, object ID, notebook title or
prose, nucleotide sequence, attachment, image, stylesheet, timestamp, or other
user content. All identifiers, URLs, labels, and nucleotide bytes were created
for this fixture.
