# IDT modification catalog — provenance

`idt-modification-catalog.snapshot.json` holds facts from Integrated DNA
Technologies' public modification catalog, retrieved 2026-08-20 by
`apps/desktop/scripts/generate-idt-modification-catalog.mjs`:

- order codes, allowed positions and the DNA/RNA oligo products that offer them;
- molecular weight, extinction coefficient at 260 nm and purification
  requirements;
- product names, catalog categories and links to each product page.

It contains no IDT images and no IDT product descriptions. Those were removed in
 (86 structure images and 242 descriptions), and
`generate-idt-modification-catalog.mjs --check` now rejects any snapshot field
outside the list above. The app links to IDT's product pages for structures and
descriptions instead of copying them.

Product names keep the trademark symbols the catalog shows. Those marks belong
to IDT and to other companies; DNAForge uses them only to name the products a
user orders.
