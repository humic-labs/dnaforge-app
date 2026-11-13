# Design Feature

State management and algorithms for DNA assembly designs. This is a large
feature containing both the Zustand store AND the assembly computation logic.

## Architecture

```
design/
├── store.ts              # Zustand store (1,591 LOC - needs splitting)
├── algorithms/
│   ├── draft-assembly.ts # Main assembly logic (1,647 LOC)
│   ├── tm-calculator.ts  # Melting temperature calculation
│   └── GIBSON-ASSEMBLY.md # Design doc
├── types.ts              # TypeScript interfaces
└── index.ts
```

**Note:** This feature is large (~3,200 LOC between store and algorithms). It's
a known architectural debt item - see `docs/CODE_REVIEW_FINDINGS.md`.

## Key Concepts

- **Design**: A saved assembly configuration (regions, primers, method)
- **Region**: A DNA fragment in the assembly (has sequence, primers, position)
- **Junction**: Where two regions connect (GoldenGate overhang or Gibson
  homology)
- **Primer**: Oligonucleotide for PCR amplification of a region
- **Draft Assembly**: The computed result of assembling regions

## Data Flow

```
User adds regions to design
    ↓
store.ts saves to Zustand state + localStorage
    ↓
algorithms/draft-assembly.ts computes assembly
    ↓
store.ts updates with computed results (junctions, primers)
    ↓
current .wpdesign.json mirror is updated when the design has a backing artifact
    ↓
assembly-panel/ renders the UI
```

The design store is still the active editor model, and localStorage is still the
legacy persistence mechanism.  adds a workspace artifact layer on top:
new assembly drafts created from the file explorer start as pending
`Untitled.wpdesign.json` files, then commit to a stable design ID, a catalog
entity/file binding, and a mirrored artifact snapshot. The artifact file is the
portable recovery path; Zustand/localStorage are the live editor cache.

## Store Structure (1,591 LOC)

The store handles:

- Design CRUD (create, load, save, delete)
- Region management (add, remove, reorder)
- Primer management (add, update, compute)
- Junction/homology state
- UI state (selected region, scroll position)
- Hydration from localStorage
- Mirroring to the current `.wpdesign.json` artifact when one is bound

**Known issue:** This store needs splitting into smaller modules.

## Algorithms (1,647 LOC in draft-assembly.ts)

The main computation file handles:

- Junction identification (GoldenGate/Gibson)
- Primer computation and validation
- Spacer insertion logic
- Assembly validation

## Common Tasks

### Reading design state

```typescript
import { useDesignStore } from '@/features/design/store';

// Get current design
const design = useDesignStore((s) => s.designs[designId]);

// Get all regions
const regions = useDesignStore((s) => s.designs[designId]?.regions ?? []);
```

### Modifying design

```typescript
const { addRegion, updateRegion, removeRegion } = useDesignStore();

// Add a region
addRegion(designId, { name: 'Fragment 1', sequence: 'ATCG...' });

// Update a region
updateRegion(designId, regionId, { name: 'New Name' });
```

## Interacts With

| Feature           | How                                           |
| ----------------- | --------------------------------------------- |
| `assembly-panel/` | UI reads design state, calls store actions    |
| `canvas/`         | Opens design tabs via `openTab('design', id)` |
| `page/`           | Design embeds reference design state          |

## Common Mistakes

1. **Adding more to the store** - It's already 1,591 LOC. If you're adding pure
   computation, put it in `algorithms/` instead.

2. **Directly mutating regions array** - Use store actions (`addRegion`,
   `updateRegion`) which handle persistence.

3. **Confusing cache with artifact identity** - Designs still hydrate from
   localStorage, but file-created designs also have a stable `.wpdesign.json`
   artifact and catalog binding. Schema changes may need both localStorage
   migration and artifact compatibility logic.

4. **Duplicating algorithm logic** - Check `draft-assembly.ts` before writing
   new computation.

## Related Docs

- `algorithms/GIBSON-ASSEMBLY.md` - Gibson assembly algorithm
- `docs/ARTIFACT_IDENTITY.md` - Stable IDs, file bindings, and artifact files
- `docs/WORKSPACE_CATALOG.md` - Catalog/data-flow model
- `docs/CODE_REVIEW_FINDINGS.md` - Architectural analysis
