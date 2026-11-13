import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

import { IUPAC_COMPLEMENT } from '@waypoint/sequence-utils/iupac';

const rustPairs = Object.entries(IUPAC_COMPLEMENT)
  .filter(([base]) => /^[A-Z]$/.test(base))
  .sort(([left], [right]) => left.charCodeAt(0) - right.charCodeAt(0))
  .map(([base, partner]) => `        b'${base}' => b'${partner}',`)
  .join('\n');
const resources = [
  {
    destination: fileURLToPath(
      new URL('../src/dnaforge_annotation/data/iupac-complements.json', import.meta.url)
    ),
    generated: `${JSON.stringify(IUPAC_COMPLEMENT, Object.keys(IUPAC_COMPLEMENT).sort(), 2)}\n`,
  },
  {
    destination: fileURLToPath(
      new URL('../../../tools/dna-assembly/src/iupac_complements.rs', import.meta.url)
    ),
    generated: `#[inline]\npub(super) fn complement(base: u8) -> u8 {\n    match base.to_ascii_uppercase() {\n${rustPairs}\n        _ => b'N',\n    }\n}\n`,
  },
];

for (const { destination, generated } of resources) {
  if (process.argv.includes('--check')) {
    let existing;
    try {
      existing = await readFile(destination, 'utf8');
    } catch {
      process.stderr.write(`missing generated complement resource: ${destination}\n`);
      process.exitCode = 1;
      continue;
    }
    if (existing !== generated) {
      process.stderr.write(`generated complement resource is stale: ${destination}\n`);
      process.exitCode = 1;
    }
  } else {
    await writeFile(destination, generated);
  }
}
