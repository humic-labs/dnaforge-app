import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  adoptInventoryState,
  applyInventoryCommandBatch,
  applyInventoryMappedTable,
  applyInventorySourceRevision,
  createInventoryState,
  INVENTORY_RECEIVE_TABLE_COLUMNS,
  inventoryMappedTablePreview,
  inventorySourceRevisionPreview,
  inventoryTableBindingKey,
  inventoryTableSha256,
  inventoryWellId,
  normalizeInventoryMappedTable,
  parseInventoryReceiveTableSource,
  type InventoryCommand,
  type InventoryExecutionContext,
  type InventoryMappedTableChoices,
  type InventoryMappedTablePreviewInput,
  type InventoryReceiveTableFields,
  type InventoryState,
} from './inventory';

const source = readFileSync(
  new URL('../../../../test-fixtures/lims-import/walkthrough/primers-messy.csv', import.meta.url),
  'utf8'
);
const headers = source.split(/\r?\n/u)[0].split(',');
const maxBytes = 17 * 1024 * 1024;
const native = {
  principal: { kind: 'agent', identityId: 'mapped-receiver' },
  authority: { kind: 'local-profile', profileKey: 'profile' },
} as const;
const ctx = (state: InventoryState | null): InventoryExecutionContext => ({
  ...native,
  at: (state?.lastRecordedAt ?? 0) + 1,
});
const target = (state: InventoryState | null) => ({
  projectId: 'project',
  inventoryId: 'inventory',
  present: state !== null,
  revision: state?.revision ?? 0,
});
function choices(): InventoryMappedTableChoices {
  return {
    namespace: 'synthetic:primer-register:stable',
    delimiter: ',',
    columns: { sourceId: 'Primer ID', plate: 'Plate', well: 'Well' },
    materials: ['MP001', 'MP002', 'MP003'].map((sourceId) => ({
      sourceId,
      materialId: `scientific:${sourceId}`,
    })),
    plates: [
      {
        sourcePlate: 'Plate-7',
        storageId: 'plate-7',
        positions: [
          { sourceWell: 'A01', position: 'A1' },
          { sourceWell: 'A02', position: 'A2' },
        ],
      },
      {
        sourcePlate: 'Plate-8',
        storageId: 'plate-8',
        positions: [{ sourceWell: 'B01', position: 'B1' }],
      },
    ],
    quantity: { kind: 'unknown', reason: 'The source contains no measured volumes' },
    qualities: [
      { sourceId: 'MP001', quality: 'usable', reason: 'Explicit local acceptance decision' },
      {
        sourceId: 'MP002',
        quality: 'quarantined',
        reason: 'Explicitly quarantine despite source QC pass',
      },
      { sourceId: 'MP003', quality: 'quarantined', reason: 'Explicit local review decision' },
    ],
    evidenceOnlyColumns: headers
      .filter((column) => !['Primer ID', 'Plate', 'Well'].includes(column))
      .map((column) => ({ column, reason: 'Retain the original value as source evidence only' })),
    skips: [],
  };
}
function execute(state: InventoryState, commands: readonly InventoryCommand[]): InventoryState {
  const result = applyInventoryCommandBatch(
    state,
    { expectedRevision: state.revision, commands },
    ctx(state)
  );
  if (!result.ok) throw new Error(result.message);
  return result.state;
}
function fixture(): InventoryState {
  return execute(createInventoryState(), [
    {
      kind: 'create-layout-storage',
      id: 'plate-7',
      name: 'Explicit Plate-7',
      layout: { kind: 'fixed-well', rows: 2, columns: 2 },
      placement: { kind: 'root' },
    },
    {
      kind: 'create-layout-storage',
      id: 'plate-8',
      name: 'Explicit Plate-8',
      layout: { kind: 'fixed-well', rows: 2, columns: 2 },
      placement: { kind: 'root' },
    },
  ]);
}
function input(
  state: InventoryState | null,
  sourceText = source,
  options = choices()
): InventoryMappedTablePreviewInput {
  return {
    target: target(state),
    sourceText,
    options,
    bindings: options.materials.map((material) => ({
      ...material,
      kind: 'admitted',
      fingerprint: inventoryTableSha256(material.materialId),
    })),
    asOf: ctx(state).at,
    ...native,
    maxBytes,
  };
}
function receive(state = fixture(), sourceText = source, options = choices()): InventoryState {
  const proposal = input(state, sourceText, options);
  const preview = inventoryMappedTablePreview(state, proposal);
  if (preview.kind !== 'ready') throw new Error(JSON.stringify(preview.issues));
  const result = applyInventoryMappedTable(
    state,
    {
      target: proposal.target,
      sourceText,
      options: preview.options,
      expectedPlanDigest: preview.planDigest,
    },
    ctx(state),
    maxBytes
  );
  if (!result.ok) throw new Error(result.message);
  return result.state;
}
const binding = (state: InventoryState, id = 'MP001') =>
  state.tableBindings[inventoryTableBindingKey(choices().namespace, id)];
const csv = (value: string) => `"${value.replaceAll('"', '""')}"`;
const table = (fields: readonly InventoryReceiveTableFields[]) =>
  [
    INVENTORY_RECEIVE_TABLE_COLUMNS.join(','),
    ...fields.map((row) =>
      INVENTORY_RECEIVE_TABLE_COLUMNS.map((column) => csv(row[column])).join(',')
    ),
  ].join('\n');

describe('mapped plate spreadsheets', () => {
  it('preserves all thirteen fixture columns and delegates three unknown-volume stocks to existing permanent wells', () => {
    const state = fixture();
    const before = structuredClone(state);
    const preview = inventoryMappedTablePreview(state, input(state));
    expect(preview.kind).toBe('ready');
    if (preview.kind !== 'ready') throw new Error(JSON.stringify(preview.issues));
    expect(preview.headers).toEqual(headers);
    expect(preview.rows).toHaveLength(3);
    expect(preview.rows.map((row) => Object.keys(row.sourceFields!))).toEqual([
      headers,
      headers,
      headers,
    ]);
    expect(preview.rows[0].sourceFields).toMatchObject({
      'Oligo Sequence': 'GTAAAACGACGGCCAGT',
      'Freezer Box': 'Box A',
      'Legacy ID': 'old-001',
      'QC Flag': 'pass',
    });
    expect(preview.sourceSha256).toBe(
      `sha256:${createHash('sha256').update(source).digest('hex')}`
    );
    expect(preview.innerPreview?.kind).toBe('ready');
    expect(preview.innerPreview?.commands).toHaveLength(3);
    expect(preview.rows.map((row) => row.vesselId)).toEqual([
      inventoryWellId('plate-7', 'A1'),
      inventoryWellId('plate-7', 'A2'),
      inventoryWellId('plate-8', 'B1'),
    ]);
    expect(preview.rows[1].quality).toBe('quarantined');
    expect(state).toEqual(before);
    const accepted = receive(state);
    expect(accepted.schema).toBe(state.schema);
    expect(accepted.revision).toBe(state.revision + 1);
    expect(accepted.storage).toEqual(state.storage);
    expect(accepted.vessels).toEqual(state.vessels);
    expect(Object.values(accepted.stocks).map((stock) => stock.quantity)).toEqual([
      { kind: 'unknown' },
      { kind: 'unknown' },
      { kind: 'unknown' },
    ]);
    expect(accepted.stocks[binding(accepted, 'MP002').stockId].quality).toBe('quarantined');
  });
  it('discovers exact raw headers and source fields before any namespace or column roles are resolved', () => {
    const options = {
      ...choices(),
      namespace: '',
      columns: { sourceId: '', plate: '', well: '' },
      materials: [],
      plates: [],
      quantity: { kind: 'unknown' as const, reason: '' },
      qualities: [],
      evidenceOnlyColumns: [],
    };
    const preview = inventoryMappedTablePreview(fixture(), input(fixture(), source, options));
    expect(preview.kind).toBe('blocked');
    expect(preview.headers).toEqual(headers);
    expect(preview.rows[0].sourceFields?.['Primer ID']).toBe('MP001');
    expect(preview.sourceIds).toEqual([]);
    expect(preview.rows[0].sourceId).toBeNull();
  });
  it('discovers source IDs and source plate/well labels even when physical choices and reasons are incomplete', () => {
    const options = {
      ...choices(),
      materials: [],
      plates: [],
      qualities: [],
      quantity: { kind: 'unknown' as const, reason: '' },
      evidenceOnlyColumns: [],
    };
    const preview = inventoryMappedTablePreview(fixture(), input(fixture(), source, options));
    expect(preview.kind).toBe('blocked');
    expect(preview.sourceIds).toEqual(['MP001', 'MP002', 'MP003']);
    expect(preview.sourcePlates).toEqual([
      { sourcePlate: 'Plate-7', sourceWells: ['A01', 'A02'] },
      { sourcePlate: 'Plate-8', sourceWells: ['B01'] },
    ]);
    expect(preview.rows[0].sourceFields?.Notes).toBe('M13 forward control');
    expect(
      preview.rows[0].issues.some((issue) => issue.code === 'MAPPED_MATERIAL_UNRESOLVED')
    ).toBe(true);
  });
  it.each([
    [
      'missing material',
      (options: InventoryMappedTableChoices) => ({
        ...options,
        materials: options.materials.slice(1),
      }),
    ],
    [
      'missing explicit quality',
      (options: InventoryMappedTableChoices) => ({
        ...options,
        qualities: options.qualities.slice(1),
      }),
    ],
    [
      'blank quality reason',
      (options: InventoryMappedTableChoices) => ({
        ...options,
        qualities: options.qualities.map((quality, index) =>
          index === 0 ? { ...quality, reason: '' } : quality
        ),
      }),
    ],
    [
      'missing well translation',
      (options: InventoryMappedTableChoices) => ({
        ...options,
        plates: options.plates.map((plate, index) =>
          index === 0 ? { ...plate, positions: plate.positions.slice(1) } : plate
        ),
      }),
    ],
    [
      'missing evidence disposition',
      (options: InventoryMappedTableChoices) => ({
        ...options,
        evidenceOnlyColumns: options.evidenceOnlyColumns.slice(1),
      }),
    ],
    [
      'blank unknown quantity reason',
      (options: InventoryMappedTableChoices) => ({
        ...options,
        quantity: { kind: 'unknown' as const, reason: '' },
      }),
    ],
    [
      'reused column role',
      (options: InventoryMappedTableChoices) => ({
        ...options,
        columns: { ...options.columns, well: options.columns.plate },
      }),
    ],
  ])('blocks %s with no inventory effects', (_label, change) => {
    const state = fixture();
    const before = structuredClone(state);
    const preview = inventoryMappedTablePreview(state, input(state, source, change(choices())));
    expect(preview.kind).toBe('blocked');
    expect(state).toEqual(before);
  });
  it('does not translate zero-padded well labels without an explicit mapping', () => {
    const options = choices();
    const wrong = {
      ...options,
      plates: options.plates.map((plate, index) =>
        index === 0
          ? {
              ...plate,
              positions: plate.positions.map((position) => ({
                ...position,
                sourceWell: position.sourceWell.replace('0', ''),
              })),
            }
          : plate
      ),
    };
    const preview = inventoryMappedTablePreview(fixture(), input(fixture(), source, wrong));
    expect(preview.kind).toBe('blocked');
    expect(preview.rows[0].vesselId).toBeNull();
  });
  it.each([
    ['unterminated quotes', source + '"unterminated'],
    ['wrong row width', source + 'too,few,fields\n'],
    ['duplicate source identities', source.replace('MP002,', 'MP001,')],
    ['duplicate headers', source.replace('Owner,', 'Primer ID,')],
    ['blank interior row', source.replace('\nMP002,', '\n\nMP002,')],
    ['invalid UTF-8 surrogate', source + '\ud800'],
  ])('refuses %s before producing an executable interpretation', (_label, text) => {
    expect(normalizeInventoryMappedTable(text, choices(), maxBytes).kind).toBe('blocked');
  });
  it('measures raw UTF-8 bytes and does not infer another delimiter', () => {
    expect(
      normalizeInventoryMappedTable(source, choices(), new TextEncoder().encode(source).length - 1)
        .kind
    ).toBe('blocked');
    expect(
      normalizeInventoryMappedTable(source, { ...choices(), delimiter: '\t' }, maxBytes).kind
    ).toBe('blocked');
  });
  it('accepts explicitly selected TSV and a single BOM without altering original source evidence', () => {
    const tsv = '\uFEFF' + source.replaceAll(',', '\t');
    const options = { ...choices(), delimiter: '\t' as const };
    const preview = inventoryMappedTablePreview(fixture(), input(fixture(), tsv, options));
    expect(preview.kind).toBe('ready');
    expect(preview.rows[0].sourceFields?.['Primer ID']).toBe('MP001');
    expect(preview.sourceSha256).toBe(inventoryTableSha256(tsv));
  });
  it('normalizes quoted non-ASCII values and prototype-like column/source identities without changing their meaning', () => {
    const text =
      '__proto__,constructor,Well,Notes\n" 001 ","Plate, α",A01,"multiline\ncontinued"\n';
    const options: InventoryMappedTableChoices = {
      ...choices(),
      namespace: '__proto__',
      columns: { sourceId: '__proto__', plate: 'constructor', well: 'Well' },
      materials: [{ sourceId: ' 001 ', materialId: 'scientific:MP001' }],
      plates: [
        {
          sourcePlate: 'Plate, α',
          storageId: 'plate-7',
          positions: [{ sourceWell: 'A01', position: 'A1' }],
        },
      ],
      qualities: [{ sourceId: ' 001 ', quality: 'usable', reason: 'Explicit choice' }],
      evidenceOnlyColumns: [{ column: 'Notes', reason: 'Source evidence only' }],
    };
    const preview = inventoryMappedTablePreview(fixture(), input(fixture(), text, options));
    expect(preview.kind).toBe('ready');
    expect(preview.rows[0].sourceFields?.__proto__).toBe(' 001 ');
    expect(preview.rows[0].sourceFields?.constructor).toBe('Plate, α');
    expect(preview.rows[0].sourceFields?.Notes).toBe('multiline\ncontinued');
    expect(Object.prototype).not.toHaveProperty('Plate, α');
    const accepted = receive(fixture(), text, options);
    expect(accepted.tableBindings[inventoryTableBindingKey('__proto__', ' 001 ')].sourceId).toBe(
      ' 001 '
    );
  });
  it('rejects unused and duplicate explicit resolutions rather than silently choosing one', () => {
    const options = choices();
    for (const changed of [
      { ...options, materials: [...options.materials, options.materials[0]] },
      {
        ...options,
        materials: [...options.materials, { sourceId: 'not-in-source', materialId: 'material' }],
      },
      { ...options, plates: [...options.plates, options.plates[0]] },
      {
        ...options,
        evidenceOnlyColumns: [
          ...options.evidenceOnlyColumns,
          { column: 'Plate', reason: 'Cannot also be evidence-only' },
        ],
      },
      { ...options, skips: [{ sourceId: 'not-in-source', reason: 'Absent' }] },
    ])
      expect(normalizeInventoryMappedTable(source, changed, maxBytes).kind).toBe('blocked');
  });
  it('refuses noninjective destination mappings and leaves the entire proposal unapplied', () => {
    const options = choices();
    const duplicate = {
      ...options,
      plates: options.plates.map((plate, index) =>
        index === 0
          ? {
              ...plate,
              positions: plate.positions.map((position) => ({ ...position, position: 'A1' })),
            }
          : plate
      ),
    };
    expect(inventoryMappedTablePreview(fixture(), input(fixture(), source, duplicate)).kind).toBe(
      'blocked'
    );
    const crossPlate = {
      ...options,
      plates: options.plates.map((plate, index) =>
        index === 1
          ? { ...plate, storageId: 'plate-7', positions: [{ sourceWell: 'B01', position: 'A1' }] }
          : plate
      ),
    };
    expect(inventoryMappedTablePreview(fixture(), input(fixture(), source, crossPlate)).kind).toBe(
      'blocked'
    );
  });
  it('uses actual permanent wells and blocks late occupied destinations atomically', () => {
    const state = execute(fixture(), [
      {
        kind: 'receive-stock',
        id: 'existing-stock',
        vesselId: inventoryWellId('plate-8', 'B1'),
        materialId: 'unrelated-material',
        quantity: { kind: 'unknown' },
        quality: 'usable',
      },
    ]);
    const before = structuredClone(state);
    const preview = inventoryMappedTablePreview(state, input(state));
    expect(preview.kind).toBe('blocked');
    expect(preview.issues.some((issue) => issue.code === 'STOCK_ALREADY_PRESENT')).toBe(true);
    expect(state).toEqual(before);
    const options = choices();
    const missing = {
      ...options,
      plates: options.plates.map((plate) => ({ ...plate, storageId: 'missing-plate' })),
    };
    expect(inventoryMappedTablePreview(state, input(state, source, missing)).kind).toBe('blocked');
    const wrong = {
      ...options,
      plates: options.plates.map((plate) => ({
        ...plate,
        positions: plate.positions.map((position) => ({ ...position, position: 'Z99' })),
      })),
    };
    expect(inventoryMappedTablePreview(state, input(state, source, wrong)).kind).toBe('blocked');
  });
  it('supports explicit skipped rows without scientific/quality bindings, but never skips malformed structure or duplicate IDs', () => {
    const options = choices();
    const skipped = {
      ...options,
      materials: options.materials.slice(1),
      qualities: options.qualities.slice(1),
      plates: options.plates.map((plate, index) =>
        index === 0 ? { ...plate, positions: plate.positions.slice(1) } : plate
      ),
      skips: [{ sourceId: 'MP001', reason: 'Explicitly exclude this row' }],
    };
    const state = receive(fixture(), source.replace(',Plate-7,A01,', ',,,'), skipped);
    expect(Object.keys(state.stocks)).toHaveLength(2);
    expect(
      state.tableBindings[inventoryTableBindingKey(options.namespace, 'MP001')]
    ).toBeUndefined();
    const all = {
      ...options,
      skips: options.materials.map((row) => ({
        sourceId: row.sourceId,
        reason: 'Explicitly exclude all source rows',
      })),
    };
    const preview = inventoryMappedTablePreview(fixture(), input(fixture(), source, all));
    expect(preview.kind).toBe('no-change');
    if (preview.kind !== 'no-change') throw new Error(JSON.stringify(preview.issues));
    expect(preview.options.materials).toEqual([]);
    expect(preview.innerPreview?.commands).toEqual([]);
    expect(
      normalizeInventoryMappedTable(
        source.replace('MP002,', 'MP001,'),
        { ...all, skips: all.skips.filter((row) => row.sourceId !== 'MP002') },
        maxBytes
      ).kind
    ).toBe('blocked');
  });
  it('ignores an unfinished physical quality choice after the source row is explicitly skipped', () => {
    const original = choices();
    const options: InventoryMappedTableChoices = {
      ...original,
      qualities: original.qualities.map((quality, index) =>
        index === 0 ? { ...quality, reason: '' } : quality
      ),
      skips: [{ sourceId: 'MP001', reason: 'Explicitly skip this source row' }],
    };
    const state = fixture();
    const preview = inventoryMappedTablePreview(state, input(state, source, options));
    if (preview.kind !== 'ready') throw new Error(JSON.stringify(preview.issues));
    expect(preview.rows[0].kind).toBe('skipped');
    expect(preview.options.qualities.map((quality) => quality.sourceId)).toEqual([
      'MP002',
      'MP003',
    ]);
    expect(preview.options.materials.map((material) => material.sourceId)).toEqual([
      'MP002',
      'MP003',
    ]);
    const result = applyInventoryMappedTable(
      state,
      {
        target: target(state),
        sourceText: source,
        options: preview.options,
        expectedPlanDigest: preview.planDigest,
      },
      ctx(state),
      maxBytes
    );
    expect(result.ok).toBe(true);
    if (result.ok) expect(Object.keys(result.state.stocks)).toHaveLength(2);
  });
  it('pins original raw text and decision reasons while leaving evidence-only changes without physical effects', () => {
    const state = fixture();
    const first = inventoryMappedTablePreview(state, input(state));
    const revisedText = source
      .replace('M13 forward control', 'Changed evidence only')
      .replace(',pass,Box A,', ',external-new-qc,Box A,');
    const second = inventoryMappedTablePreview(state, input(state, revisedText));
    expect(first.kind).toBe('ready');
    expect(second.kind).toBe('ready');
    if (first.kind !== 'ready' || second.kind !== 'ready') throw new Error('Expected plans.');
    expect(first.normalizedSourceText).toBe(second.normalizedSourceText);
    expect(first.innerPreview?.planDigest).toBe(second.innerPreview?.planDigest);
    expect(first.planDigest).not.toBe(second.planDigest);
    const choicesWithReason = choices();
    const otherReason = {
      ...choicesWithReason,
      quantity: { kind: 'unknown' as const, reason: 'A different explicit explanation' },
    };
    const changedReason = inventoryMappedTablePreview(state, input(state, source, otherReason));
    if (changedReason.kind !== 'ready') throw new Error('Expected reason plan.');
    expect(changedReason.planDigest).not.toBe(first.planDigest);
    const accepted = receive(state);
    const before = structuredClone(accepted);
    expect(inventoryMappedTablePreview(accepted, input(accepted, revisedText)).kind).toBe(
      'no-change'
    );
    expect(accepted).toEqual(before);
  });
  it('does not duplicate, reset measurements, restore quality or undo later placement/disposal on reimport', () => {
    const accepted = receive();
    const stockId = binding(accepted).stockId;
    const used = execute(accepted, [
      {
        kind: 'reconcile',
        stockId,
        quantity: { kind: 'known', value: '50', unit: 'uL' },
        reason: 'Later actual measurement',
      },
      { kind: 'consume', stockId, quantity: { value: '5', unit: 'uL' }, reason: 'Later use' },
      { kind: 'set-quality', stockId, quality: 'quarantined', reason: 'Later quality decision' },
    ]);
    const reordered =
      [headers.join(','), ...source.trimEnd().split(/\r?\n/u).slice(1).reverse()].join('\n') + '\n';
    expect(inventoryMappedTablePreview(used, input(used, reordered)).kind).toBe('no-change');
    expect(used.stocks[stockId].quantity).toEqual({ kind: 'known', value: '45', unit: 'uL' });
    expect(used.stocks[stockId].quality).toBe('quarantined');
    const disposed = execute(used, [
      { kind: 'dispose-plate', id: 'plate-7', reason: 'Explicit later disposal' },
    ]);
    expect(inventoryMappedTablePreview(disposed, input(disposed)).kind).toBe('no-change');
    const options = choices();
    const different = {
      ...options,
      qualities: options.qualities.map((quality, index) =>
        index === 0 ? { ...quality, quality: 'quarantined' as const } : quality
      ),
    };
    expect(inventoryMappedTablePreview(used, input(used, source, different)).kind).toBe('blocked');
  });
  it('binds target revision, native material fingerprints and explicit mapping choices while excluding the native clock from plan identity', () => {
    const state = fixture();
    const proposal = input(state);
    const first = inventoryMappedTablePreview(state, proposal);
    const later = inventoryMappedTablePreview(state, { ...proposal, asOf: proposal.asOf + 100 });
    expect(later.planDigest).toBe(first.planDigest);
    const different = inventoryMappedTablePreview(state, {
      ...proposal,
      bindings: proposal.bindings.map((binding) =>
        binding.kind === 'admitted'
          ? { ...binding, fingerprint: inventoryTableSha256('changed') }
          : binding
      ),
    });
    expect(different.kind).toBe('ready');
    expect(different.planDigest).not.toBe(first.planDigest);
    expect(inventoryMappedTablePreview(state, { ...proposal, bindings: [] }).kind).toBe('blocked');
    expect(
      inventoryMappedTablePreview(state, {
        ...proposal,
        target: { ...proposal.target, revision: state.revision + 1 },
      }).kind
    ).toBe('blocked');
    if (first.kind !== 'ready') throw new Error('Expected ready plan.');
    const application = {
      target: proposal.target,
      sourceText: source,
      options: first.options,
      expectedPlanDigest: first.planDigest,
    };
    expect(
      applyInventoryMappedTable(
        state,
        { ...application, sourceText: source + '\n' },
        ctx(state),
        maxBytes
      ).ok
    ).toBe(false);
    expect(
      applyInventoryMappedTable(
        state,
        {
          ...application,
          options: {
            ...first.options,
            materials: first.options.materials.map((material) => ({
              ...material,
              fingerprint: inventoryTableSha256('changed'),
            })),
          },
        },
        ctx(state),
        maxBytes
      ).ok
    ).toBe(false);
    expect(
      applyInventoryMappedTable(
        state,
        application,
        { ...ctx(state), at: state.lastRecordedAt - 1 },
        maxBytes
      ).ok
    ).toBe(false);
  });
  it('retains canonical row preimages for explicit source-baseline acknowledgement without reconstructing current stock', () => {
    const accepted = receive();
    const normalized = normalizeInventoryMappedTable(source, choices(), maxBytes);
    if (normalized.kind !== 'normalized') throw new Error('Expected normalized source.');
    const fields = parseInventoryReceiveTableSource(
      normalized.normalizedSourceText,
      ',',
      maxBytes
    ).rows.map((row) => row.fields!);
    expect(normalized.rows.map((row) => row.fields)).toEqual(fields);
    const revised = fields.map((row) =>
      row.source_id === 'MP001' ? { ...row, quality: 'quarantined' } : row
    );
    const options = {
      table: normalized.tableOptions,
      acknowledgements: [
        {
          sourceId: 'MP001',
          expectedPreviousRowSha256: binding(accepted).rowSha256,
          reason: 'Accept revised physical source interpretation without changing stock',
        },
      ],
    };
    const proposal = inventorySourceRevisionPreview(accepted, {
      target: target(accepted),
      sourceText: table(revised),
      options,
      preimages: normalized.rows.map((row) => ({ sourceId: row.sourceId!, fields: row.fields! })),
      asOf: ctx(accepted).at,
      ...native,
      maxBytes,
    });
    if (proposal.kind !== 'ready') throw new Error(JSON.stringify(proposal.issues));
    const result = applyInventorySourceRevision(
      accepted,
      {
        target: target(accepted),
        sourceText: table(revised),
        options: proposal.options,
        expectedPlanDigest: proposal.planDigest,
      },
      ctx(accepted),
      maxBytes
    );
    if (!result.ok) throw new Error(result.message);
    expect(result.state.stocks).toEqual(accepted.stocks);
    const original = choices();
    const mapped = {
      ...original,
      qualities: original.qualities.map((quality, index) =>
        index === 0 ? { ...quality, quality: 'quarantined' as const } : quality
      ),
    };
    expect(
      inventoryMappedTablePreview(result.state, input(result.state, source, mapped)).kind
    ).toBe('no-change');
  });
  it('preserves physical correlation across archive adoption with explicitly remapped scientific identities', () => {
    const accepted = receive();
    const materialBindings = Object.fromEntries(
      choices().materials.map((row) => [row.materialId, 'destination:' + row.materialId])
    );
    const adopted = adoptInventoryState(
      null,
      accepted,
      {
        source: {
          archiveSha256: inventoryTableSha256('retained archive'),
          projectId: 'source-project',
          inventoryId: 'source-inventory',
          revision: accepted.revision,
        },
        materialBindings,
      },
      ctx(accepted)
    );
    if (!adopted.ok) throw new Error(adopted.message);
    const options = {
      ...choices(),
      materials: choices().materials.map((material) => ({
        ...material,
        materialId: materialBindings[material.materialId],
      })),
    };
    const proposal = input(adopted.state, source, options);
    const preview = inventoryMappedTablePreview(adopted.state, {
      ...proposal,
      target: {
        ...proposal.target,
        projectId: 'destination-project',
        inventoryId: 'destination-inventory',
      },
    });
    expect(preview.kind).toBe('no-change');
    expect(binding(adopted.state).stockId).toBe(binding(accepted).stockId);
    expect(binding(adopted.state).vesselId).toBe(binding(accepted).vesselId);
  });
  it('honors the existing 256-command atomic bound without silently splitting', () => {
    const count = 257;
    const state = execute(createInventoryState(), [
      {
        kind: 'create-layout-storage',
        id: 'large-plate',
        name: 'Explicit large source layout',
        layout: { kind: 'fixed-well', rows: 1, columns: count },
        placement: { kind: 'root' },
      },
    ]);
    const text =
      'ID,Plate,Well\n' +
      Array.from({ length: count }, (_, index) => `id-${index},plate,W${index}`).join('\n');
    const options: InventoryMappedTableChoices = {
      namespace: 'large-import',
      delimiter: ',',
      columns: { sourceId: 'ID', plate: 'Plate', well: 'Well' },
      materials: Array.from({ length: count }, (_, index) => ({
        sourceId: `id-${index}`,
        materialId: 'scientific-material',
      })),
      plates: [
        {
          sourcePlate: 'plate',
          storageId: 'large-plate',
          positions: Array.from({ length: count }, (_, index) => ({
            sourceWell: `W${index}`,
            position: `A${index + 1}`,
          })),
        },
      ],
      quantity: { kind: 'unknown', reason: 'No measured volumes' },
      qualities: Array.from({ length: count }, (_, index) => ({
        sourceId: `id-${index}`,
        quality: 'usable',
        reason: 'Explicit acceptance',
      })),
      evidenceOnlyColumns: [],
      skips: [],
    };
    const preview = inventoryMappedTablePreview(state, input(state, text, options));
    expect(preview.kind).toBe('blocked');
    expect(preview.issues.some((issue) => issue.code === 'TABLE_BATCH_TOO_LARGE')).toBe(true);
    expect(Object.keys(state.stocks)).toHaveLength(0);
  });
});
