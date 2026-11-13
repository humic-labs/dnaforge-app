import { describe, expect, it } from 'vitest';
import { parseMocloKitDefinition } from '../../design/public/moclo-kit-definition';
import {
  emptyLayout,
  findKitDuplicate,
  kitIdFromName,
  layoutFromSchema,
  savePayload,
  schemaFromLayout,
  stateFromDefinition,
  uniqueId,
  validateKitBuilderState,
  type KitBuilderState,
} from './moclo-kit-builder-model';

const existingKit = parseMocloKitDefinition(
  JSON.stringify({
    schema: 'dnaforge.moclo-kit',
    formatVersion: 3,
    id: 'lab-kit',
    name: 'Lab kit',
    revision: 4,
    description: 'An existing project kit.',
    citations: [],
    partTypes: [],
    members: [
      { id: 'pkg-a', name: 'Part A', sequencePackageId: 'pkg-a' },
      { id: 'pkg-b', name: 'Part B', sequencePackageId: 'pkg-b' },
    ],
    recipes: [],
    assemblySchemas: [
      {
        id: 'unit',
        name: 'Transcription unit',
        description: 'Promoter, CDS, terminator, backbone.',
        enzyme: 'BsaI',
        topology: 'circular',
        slots: [
          { id: 'promoter', label: 'Promoter', outgoingOverhang: 'AATG', preferredRoles: [] },
          { id: 'cds', label: 'CDS', outgoingOverhang: 'GCTT', preferredRoles: [] },
          {
            id: 'backbone',
            label: 'Backbone',
            outgoingOverhang: 'GGAG',
            preferredRoles: [{ label: 'Destination vector' }],
          },
        ],
      },
      {
        id: 'retired',
        name: 'Retired layout',
        description: 'No longer offered.',
        enzyme: 'BsaI',
        topology: 'circular',
        slots: [
          { id: 'a', label: 'A', outgoingOverhang: 'AATG', preferredRoles: [] },
          { id: 'b', label: 'B', outgoingOverhang: 'GGAG', preferredRoles: [] },
        ],
      },
    ],
  })
);

function stateWith(overrides: Partial<KitBuilderState> = {}): KitBuilderState {
  const layout = {
    ...emptyLayout([]),
    name: 'Unit',
    positions: [
      { id: 'p1', label: 'Promoter', outgoingOverhang: 'AATG', role: 'Promoter' },
      { id: 'p2', label: 'CDS', outgoingOverhang: 'GCTT', role: '' },
      { id: 'p3', label: 'Backbone', outgoingOverhang: 'GGAG', role: '' },
    ],
  };
  return {
    name: 'My kit',
    description: 'A kit built by hand.',
    citations: [],
    members: [],
    layouts: [layout],
    activeLayoutId: layout.id,
    ...overrides,
  };
}

describe('kitIdFromName', () => {
  it('produces a writer-acceptable id', () => {
    expect(kitIdFromName('CIDAR MoClo')).toBe('cidar-moclo');
    expect(kitIdFromName('  Lee 2015 / YTK  ')).toBe('lee-2015-ytk');
    expect(kitIdFromName('Kit — v2.0')).toBe('kit-v2-0');
  });

  it('is empty when the name carries no letters or digits', () => {
    expect(kitIdFromName('—')).toBe('');
  });
});

describe('uniqueId', () => {
  it('suffixes only on collision', () => {
    expect(uniqueId('layout', [])).toBe('layout');
    expect(uniqueId('layout', ['layout'])).toBe('layout-2');
    expect(uniqueId('layout', ['layout', 'layout-2'])).toBe('layout-3');
  });
});

describe('validateKitBuilderState', () => {
  it('accepts a complete circular layout', () => {
    expect(validateKitBuilderState(stateWith())).toEqual([]);
  });

  it('requires a name and a description', () => {
    const issues = validateKitBuilderState(stateWith({ name: '  ', description: '' }));
    expect(issues.map((issue) => issue.message)).toEqual([
      'The kit needs a name.',
      'The kit needs a description.',
    ]);
  });

  it('names the position that still has no junction', () => {
    const state = stateWith();
    state.layouts[0].positions[1].outgoingOverhang = '';
    const issues = validateKitBuilderState(state);
    expect(issues[0].message).toContain('“CDS” has no junction yet');
    expect(issues[0].message).toContain('BsaI needs 4 bases');
  });

  it('rejects an overhang of the wrong length for the enzyme', () => {
    const state = stateWith();
    state.layouts[0].enzyme = 'SapI';
    const issues = validateKitBuilderState(state);
    expect(issues.some((issue) => issue.message.includes('SapI overhangs must be 3'))).toBe(true);
  });

  it('rejects a closing junction on the last position of a linear layout', () => {
    const state = stateWith();
    state.layouts[0].topology = 'linear';
    const issues = validateKitBuilderState(state);
    expect(
      issues.some((issue) =>
        issue.message.includes('final slot in a linear schema cannot own a closing junction')
      )
    ).toBe(true);
  });

  it('reports duplicate layout ids', () => {
    const state = stateWith();
    state.layouts = [state.layouts[0], { ...state.layouts[0] }];
    const issues = validateKitBuilderState(state);
    expect(issues.some((issue) => issue.message.includes('Two layouts share an identifier'))).toBe(
      true
    );
  });
});

describe('schema and layout conversion', () => {
  it('round-trips a saved schema without inventing fields', () => {
    const layout = layoutFromSchema(existingKit.assemblySchemas[0]);
    expect(layout.positions.map((position) => position.outgoingOverhang)).toEqual([
      'AATG',
      'GCTT',
      'GGAG',
    ]);
    expect(layout.positions[2].role).toBe('Destination vector');
    expect(schemaFromLayout(layout)).toEqual(existingKit.assemblySchemas[0]);
  });

  it('turns a blank junction into null rather than an empty string', () => {
    const layout = emptyLayout([]);
    expect(schemaFromLayout(layout).slots.every((slot) => slot.outgoingOverhang === null)).toBe(
      true
    );
  });
});

describe('savePayload', () => {
  it('creates a new kit at revision 0 with an id from the name', () => {
    const payload = savePayload(stateWith({ name: 'My New Kit' }), null);
    expect(payload.kitId).toBe('my-new-kit');
    expect(payload.expectedKitRevision).toBe(0);
    expect(payload.removeSchemaIds).toBeUndefined();
    expect(payload.citations).toBeUndefined();
  });

  it('sends citations only when the kit has them', () => {
    const cited = savePayload(
      stateWith({ citations: [{ label: 'Lee et al. 2015', pmid: '25871405' }] }),
      null
    );
    expect(cited.citations).toEqual([{ label: 'Lee et al. 2015', pmid: '25871405' }]);
  });

  it('keeps the existing id and revision, and removes layouts the user deleted', () => {
    const state = stateFromDefinition(existingKit);
    state.layouts = state.layouts.filter((layout) => layout.id !== 'retired');
    const payload = savePayload(state, existingKit);
    expect(payload.kitId).toBe('lab-kit');
    expect(payload.expectedKitRevision).toBe(4);
    expect(payload.removeSchemaIds).toEqual(['retired']);
    expect(payload.assemblySchemas.map((schema) => schema.id)).toEqual(['unit']);
  });

  it('sends only newly added parts, and removes the ones dropped', () => {
    const state = stateFromDefinition(existingKit);
    expect(state.members.map((m) => m.sequencePackageId)).toEqual(['pkg-a', 'pkg-b']);
    state.members = [
      { sequencePackageId: 'pkg-a', name: 'Part A' },
      { sequencePackageId: 'pkg-new', name: 'New part' },
    ];
    const payload = savePayload(state, existingKit);
    expect(payload.members).toEqual([{ sequencePackageId: 'pkg-new' }]);
    expect(payload.removeMemberPackageIds).toEqual(['pkg-b']);
  });

  it('asks for no membership change when the parts are untouched', () => {
    const payload = savePayload(stateFromDefinition(existingKit), existingKit);
    expect(payload.members).toBeUndefined();
    expect(payload.removeMemberPackageIds).toBeUndefined();
  });

  it('does not ask to remove a layout that is still present', () => {
    const payload = savePayload(stateFromDefinition(existingKit), existingKit);
    expect(payload.removeSchemaIds).toBeUndefined();
  });
});

describe('findKitDuplicate', () => {
  const existing = [
    { id: 'ytk', name: 'Yeast Toolkit (YTK)' },
    { id: 'moclo-cidar', name: 'CIDAR MoClo' },
  ];

  it('catches the id the save would land on, even under a different name', () => {
    expect(findKitDuplicate('Bench Kit', [{ id: 'bench-kit', name: 'Something else' }])).toEqual({
      kind: 'same-id',
      existingKitId: 'bench-kit',
      existingKitName: 'Something else',
    });
  });

  it('catches the same kit named the other way round', () => {
    expect(findKitDuplicate('CIDAR MoClo', existing)).toEqual({
      kind: 'similar-name',
      existingKitId: 'moclo-cidar',
      existingKitName: 'CIDAR MoClo',
    });
  });

  it('catches a name that is the same kit wearing a prefix', () => {
    expect(findKitDuplicate('MoClo Yeast Toolkit (YTK)', existing)).toEqual({
      kind: 'similar-name',
      existingKitId: 'ytk',
      existingKitName: 'Yeast Toolkit (YTK)',
    });
  });

  it('leaves genuinely different kits alone', () => {
    expect(findKitDuplicate('EcoFlex MoClo', existing)).toBeNull();
    expect(findKitDuplicate('Mammalian Toolkit (MTK)', existing)).toBeNull();
  });

  it('says nothing about an empty or punctuation-only name', () => {
    expect(findKitDuplicate('   ', existing)).toBeNull();
    expect(findKitDuplicate('MoClo kit', existing)).toBeNull();
  });
});
