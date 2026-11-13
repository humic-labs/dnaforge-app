# Test Fixture Manifest

Index of all available test fixture data for the desktop app.

## Built-in Sequence Constants

Defined in `sequences.ts`. Import from `../fixtures/sequences`.

| Name           | Type      | Length | Circular | Annotations | Notes                          |
| -------------- | --------- | ------ | -------- | ----------- | ------------------------------ |
| `MINI_PLASMID` | Synthetic | 100bp  | Yes      | 1 CDS (GFP) | Minimal fixture for fast tests |
| `PUC19`        | Plasmid   | 2686bp | Yes      | 20          | Canonical public pUC19 fixture |
| `GFP_LINEAR`   | CDS       | 720bp  | No       | 1 CDS (GFP) | Realistic eGFP coding sequence |

## File Content Constants

| Name            | Format  | Description                      |
| --------------- | ------- | -------------------------------- |
| `PUC19_GENBANK` | GenBank | Canonical GenBank file for pUC19 |
| `GFP_FASTA`     | FASTA   | FASTA file for GFP               |

## Scenario Modifier Shortcuts

Import from `../scenarios/sequences`.

| Modifier                    | Adds Sequence | Adds Tab | Adds File     | Path                   |
| --------------------------- | ------------- | -------- | ------------- | ---------------------- |
| `withPUC19(scenario)`       | PUC19         | sequence | PUC19_GENBANK | `/workspace/pUC19.gb`  |
| `withGFP(scenario)`         | GFP_LINEAR    | sequence | GFP_FASTA     | `/workspace/gfp.fasta` |
| `withMiniPlasmid(scenario)` | MINI_PLASMID  | sequence | (none)        | `/workspace/mini.gb`   |

## Factory Function

Use `createSequenceFixture()` from `../scenarios/sequences` for custom fixtures:

```typescript
import { createSequenceFixture } from '../scenarios/sequences';

const mySeq = createSequenceFixture({
  name: 'Custom Plasmid',
  length: 5000,
  circular: true,
  annotations: [
    { name: 'KanR', type: 'CDS', start: 100, end: 900, direction: 1 },
  ],
});
```

## wp-assets References (external repo)

Located at `../wp-assets/` relative to the monorepo root.

| Name                     | Path in wp-assets                    | Type         | Used By                |
| ------------------------ | ------------------------------------ | ------------ | ---------------------- |
| collision-test-synthetic | `00-assembly/test-fixtures/`         | Synthetic    | E2E GoldenGate         |
| pPCY series (236 files)  | `test-data/assembly/active/03-pPCY/` | Research     | Assembly CLI           |
| perf plasmids (8 files)  | `test-data/desktop-perf/`            | Performance  | Scroll/nav E2E         |
| db-startup fixtures      | `test-data/db-startup/`              | Seed data    | Database init          |
| import fixtures          | `test-data/import/`                  | Multi-format | File import tests      |
| notebook fixtures        | `test-data/notebook/`                | JSON         | Notebook feature tests |

## Adding a New Fixture

1. **Small constant (< 1KB)**: Add to `sequences.ts` as an exported const
2. **File-based fixture**: Add to `wp-assets/test-data/<domain>/` and reference
   here
3. **Create a `with<Name>()` modifier** in `sequences.ts` for common use
4. **Custom one-off**: Use `createSequenceFixture()` inline in your test
5. **Update this manifest** when adding new constants or modifiers
