import { createHash } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { applyInventoryCommandBatch } from './inventory-state';
import {
  createInventoryState,
  type InventoryCommand,
  type InventoryExecutionContext,
} from './inventory-types';
import { parseInventoryCommandBatch, parseInventoryExecutionContext } from './inventory-validation';
import {
  canonicalInventoryArchiveValue,
  createInventoryArchive,
  inventoryImportFailurePreview,
  inventoryImportPreview,
  InventoryArchiveError,
  MAX_INVENTORY_ARCHIVE_DEPTH,
  parseInventoryArchive,
} from './inventory-archive';
import type {
  InventoryArchiveCapture,
  InventoryArchiveDocument,
  InventoryArchiveRuntime,
  InventoryArchiveSha256,
  InventoryImportPreviewInput,
} from './inventory-archive-types';

const sha256 = (text: string): InventoryArchiveSha256 =>
  `sha256:${createHash('sha256').update(text).digest('hex')}`;
const context: InventoryExecutionContext = {
  at: 1_700_000_000_000,
  principal: { kind: 'agent', identityId: 'source-agent' },
  authority: { kind: 'local-profile', profileKey: 'a'.repeat(64) },
};
const scope = { projectId: 'source-project', inventoryId: 'source-inventory' };
const runtime: InventoryArchiveRuntime = {
  maxBytes: 17 * 1024 * 1024,
  sha256,
  replayJournal({ source, rows }) {
    let state = createInventoryState();
    for (const row of rows) {
      const request = row.request as {
        expectedRevision: number;
        commands: unknown;
        project: string;
        inventoryId: string;
        operationId: string;
      };
      const receipt = row.receipt as {
        recordedAt: number;
        context: unknown;
        operationId: string;
        revision: number;
        requestDigest: string;
      };
      expect(request.project).toBe(source.projectId);
      expect(request.inventoryId).toBe(source.inventoryId);
      expect(request.operationId).toBe(row.operationId);
      expect(receipt.operationId).toBe(row.operationId);
      expect(receipt.revision).toBe(row.revision);
      expect(receipt.requestDigest).toBe(sha256(canonicalInventoryArchiveValue(request)));
      const transition = applyInventoryCommandBatch(
        state,
        parseInventoryCommandBatch({
          expectedRevision: request.expectedRevision,
          commands: request.commands,
        }),
        parseInventoryExecutionContext({ ...(receipt.context as object), at: receipt.recordedAt })
      );
      if (!transition.ok) throw new Error(transition.message);
      state = transition.state;
    }
    return state;
  },
};

function fixture(count = 2) {
  let state = createInventoryState();
  const history: InventoryArchiveCapture['history'][number][] = [];
  for (let index = 0; index < count; index++) {
    const commands: readonly InventoryCommand[] =
      index === 0
        ? [
            {
              kind: 'create-storage',
              id: 'freezer',
              name: 'Synthetic freezer',
              slots: ['A'],
              placement: { kind: 'root' },
            },
            {
              kind: 'create-vessel',
              id: 'tube',
              name: 'Exact source tube',
              placement: { kind: 'located', storageId: 'freezer', slotId: 'A' },
            },
            {
              kind: 'receive-stock',
              id: 'stock',
              vesselId: 'tube',
              materialId: 'source-a',
              quantity: { kind: 'known', value: '100.000', unit: 'uL' },
              quality: 'usable',
            },
            {
              kind: 'record-composition',
              stockId: 'stock',
              composition: {
                kind: 'homogeneous',
                analytes: { 'analyte/a~b': { kind: 'known', value: '3.000', unit: 'ng/uL' } },
              },
              reason: 'Exact formulation',
            },
            {
              kind: 'create-lot',
              id: 'lot',
              materialId: 'lot-material',
              name: 'Immutable contribution snapshot',
              origin: {
                kind: 'prepared',
                sourceStockIds: ['stock'],
                method: 'Synthetic preparation',
              },
            },
            {
              kind: 'reserve-quantity',
              id: 'hold',
              stockId: 'stock',
              quantity: { value: '20', unit: 'uL' },
              deadline: null,
              purpose: 'Retain foreign ownership',
            },
            {
              kind: 'attach-item-code',
              id: 'code',
              namespace: 'internal',
              value: ' 00123 ',
              item: { kind: 'vessel', id: 'tube' },
              reason: 'Exact physical alias',
            },
          ]
        : [
            {
              kind: 'create-vessel',
              id: `empty-${index}`,
              name: `Empty ${index}`,
              placement: { kind: 'unplaced' },
            },
          ];
    const request = {
      project: scope.projectId,
      inventoryId: scope.inventoryId,
      operationId: `op-${index}`,
      expectedRevision: state.revision,
      commands,
    };
    const at = context.at + index;
    const transition = applyInventoryCommandBatch(
      state,
      { expectedRevision: state.revision, commands },
      { ...context, at }
    );
    if (!transition.ok) throw new Error(`${transition.code}: ${transition.message}`);
    state = transition.state;
    const receipt = {
      operationId: request.operationId,
      revision: state.revision,
      recordedAt: at,
      context: { principal: context.principal, authority: context.authority },
      requestDigest: sha256(canonicalInventoryArchiveValue(request)),
    };
    history.push({
      operationId: request.operationId,
      revision: state.revision,
      requestJson: ` ${JSON.stringify(request, null, 2)}\n`,
      receiptJson: `${JSON.stringify(receipt)}\n`,
    });
  }
  const capture: InventoryArchiveCapture = {
    ...scope,
    state: { revision: state.revision, json: `${JSON.stringify(state, null, 2)}\n` },
    history,
  };
  return { capture, state, artifact: createInventoryArchive(capture, runtime) };
}

function rewritten(text: string, mutate: (document: InventoryArchiveDocument) => void): string {
  const document = JSON.parse(text) as InventoryArchiveDocument;
  mutate(document);
  return canonicalInventoryArchiveValue({
    ...document,
    contentSha256: sha256(canonicalInventoryArchiveValue(document.content)),
  });
}

function previewInput(f: ReturnType<typeof fixture>): InventoryImportPreviewInput {
  const refs = parseInventoryArchive(f.artifact.sourceText, runtime).document.content
    .scientificReferences;
  return {
    target: {
      projectId: 'destination-project',
      inventoryId: 'destination-inventory',
      present: false,
      revision: 0,
    },
    options: {
      bindings: refs.map((row) => ({
        sourceMaterialId: row.materialId,
        destinationMaterialId: `destination:${row.materialId}`,
      })),
    },
    bindings: refs.map((row) => ({
      kind: 'admitted',
      sourceMaterialId: row.materialId,
      destinationMaterialId: `destination:${row.materialId}`,
      fingerprint: sha256(row.materialId),
    })),
    asOf: f.state.lastRecordedAt,
  };
}

describe('exact native inventory archives', () => {
  it('retains original state, request and receipt strings while repeated captures are deterministic', () => {
    const f = fixture();
    expect(createInventoryArchive(f.capture, runtime)).toEqual(f.artifact);
    const parsed = parseInventoryArchive(f.artifact.sourceText, runtime);
    expect(parsed.state).toEqual(f.state);
    expect(parsed.document.content.state).toMatchObject({
      kind: 'present',
      json: f.capture.state!.json,
    });
    expect(parsed.document.content.history.map((row) => row.requestJson)).toEqual(
      f.capture.history.map((row) => row.requestJson)
    );
    expect(parsed.document.content.history.map((row) => row.receiptJson)).toEqual(
      f.capture.history.map((row) => row.receiptJson)
    );
    expect(parsed.state!.itemCodes.code.value).toBe(' 00123 ');
    expect(parsed.state!.stocks.stock.quantity).toEqual({
      kind: 'known',
      value: '100',
      unit: 'uL',
    });
    expect(parsed.state!.stocks.stock.composition).toEqual({
      kind: 'homogeneous',
      analytes: {
        'analyte/a~b': { kind: 'known', numerator: '3', denominator: '1', unit: 'ng/uL' },
      },
    });
  });

  it('includes the complete history beyond a public history page and source reference pointers', () => {
    const f = fixture(101);
    const parsed = parseInventoryArchive(f.artifact.sourceText, runtime);
    expect(parsed.document.content.history).toHaveLength(101);
    expect(parsed.document.content.history.at(-1)?.revision).toBe(101);
    const analyte = parsed.document.content.scientificReferences.find(
      (row) => row.materialId === 'analyte/a~b'
    );
    expect(analyte?.pointers).toContain('/stocks/stock/composition/analytes/analyte~1a~0b');
    expect(parsed.document.content.scientificReferences.map((row) => row.materialId)).toEqual([
      'analyte/a~b',
      'lot-material',
      'source-a',
    ]);
  });

  it('exports an absent inventory without invoking replay or creating recorded data', () => {
    const replayJournal = vi.fn(runtime.replayJournal);
    const artifact = createInventoryArchive(
      { ...scope, state: null, history: [] },
      { ...runtime, replayJournal }
    );
    const parsed = parseInventoryArchive(artifact.sourceText, { ...runtime, replayJournal });
    expect(parsed.state).toBeNull();
    expect(parsed.document.content.source).toMatchObject({ revision: 0, storedSchema: null });
    expect(parsed.document.content.history).toEqual([]);
    expect(replayJournal).not.toHaveBeenCalled();
    expect(
      inventoryImportPreview(
        parsed,
        {
          target: { projectId: 'target', inventoryId: 'existing', present: true, revision: 40 },
          options: { bindings: [] },
          bindings: [],
          asOf: context.at,
        },
        runtime
      )
    ).toMatchObject({ kind: 'no-change', planDigest: null, options: null });
  });

  it('refuses duplicate keys in the outer archive and every embedded JSON payload', () => {
    const f = fixture();
    const duplicateOuter = f.artifact.sourceText.replace(
      '{',
      '{"schema":"dnaforge.inventory-export.v1",'
    );
    expect(() => parseInventoryArchive(duplicateOuter, runtime)).toThrow('duplicated');
    for (const target of ['state', 'request', 'receipt'] as const) {
      const source = rewritten(f.artifact.sourceText, (document) => {
        if (target === 'state' && document.content.state.kind === 'present') {
          const raw = document.content.state.json.replace(
            '{',
            '{"schema":"dnaforge.inventory.v11",'
          );
          Object.assign(document.content.state, { json: raw, sha256: sha256(raw) });
        } else {
          const row = document.content.history[0];
          const key = target === 'request' ? 'requestJson' : 'receiptJson';
          const digest = target === 'request' ? 'requestSha256' : 'receiptSha256';
          const raw = row[key].replace('{', '{"operationId":"op-0",');
          Object.assign(row, { [key]: raw, [digest]: sha256(raw) });
        }
      });
      expect(() => parseInventoryArchive(source, runtime)).toThrow('duplicated');
    }
  });

  it('rejects tampering with each raw payload even when the outer content hash is recomputed', () => {
    const f = fixture();
    for (const target of ['state', 'request', 'receipt'] as const) {
      const source = rewritten(f.artifact.sourceText, (document) => {
        if (target === 'state' && document.content.state.kind === 'present')
          Object.assign(document.content.state, { json: `${document.content.state.json} ` });
        else
          Object.assign(document.content.history[0], {
            [target === 'request' ? 'requestJson' : 'receiptJson']: '{}',
          });
      });
      expect(() => parseInventoryArchive(source, runtime)).toThrow('hash does not match');
    }
    expect(() =>
      parseInventoryArchive(
        f.artifact.sourceText.replace('source-project', 'other-project'),
        runtime
      )
    ).toThrow('content hash');
  });

  it('rejects incomplete, reordered and duplicate operation history', () => {
    const f = fixture();
    const mutations = [
      (d: InventoryArchiveDocument) => {
        (d.content.history as unknown[]).pop();
      },
      (d: InventoryArchiveDocument) => {
        (d.content.history as unknown[]).reverse();
      },
      (d: InventoryArchiveDocument) => {
        Object.assign(d.content.history[1], { operationId: d.content.history[0].operationId });
      },
    ];
    for (const mutation of mutations)
      expect(() =>
        parseInventoryArchive(rewritten(f.artifact.sourceText, mutation), runtime)
      ).toThrow(InventoryArchiveError);
  });

  it('requires native accepted-journal validation and exact replay parity', () => {
    const f = fixture();
    expect(() =>
      parseInventoryArchive(f.artifact.sourceText, {
        ...runtime,
        replayJournal: () => {
          throw new Error('Saved request digest differs.');
        },
      })
    ).toThrow('Saved request digest differs');
    expect(() =>
      parseInventoryArchive(f.artifact.sourceText, {
        ...runtime,
        replayJournal: () => createInventoryState(),
      })
    ).toThrow('differs from its complete accepted history');
    const requestEdited = rewritten(f.artifact.sourceText, (document) => {
      const row = document.content.history[0];
      const request = JSON.parse(row.requestJson);
      request.commands[2].quantity.value = '99';
      const requestJson = JSON.stringify(request);
      Object.assign(row, { requestJson, requestSha256: sha256(requestJson) });
    });
    expect(() => parseInventoryArchive(requestEdited, runtime)).toThrow(InventoryArchiveError);
  });

  it('does not accept a reference manifest that omits immutable contribution or analyte facts', () => {
    const f = fixture();
    const edited = rewritten(f.artifact.sourceText, (document) => {
      (document.content.scientificReferences as unknown[]).pop();
    });
    expect(() => parseInventoryArchive(edited, runtime)).toThrow(
      'reference manifest does not match'
    );
  });

  it('bounds actual UTF-8 bytes, nested retained archives and JSON depth without truncation', () => {
    const f = fixture();
    expect(() =>
      parseInventoryArchive(f.artifact.sourceText, { ...runtime, maxBytes: 100 })
    ).toThrow('encoded transport size');
    const unicode = createInventoryArchive(
      { projectId: 'é'.repeat(16), inventoryId: 'absent', state: null, history: [] },
      runtime
    );
    expect(() =>
      parseInventoryArchive(unicode.sourceText, {
        ...runtime,
        maxBytes: unicode.sourceText.length + 1,
      })
    ).toThrow('encoded transport size');
    expect(() =>
      parseInventoryArchive(f.artifact.sourceText, runtime, {
        depth: MAX_INVENTORY_ARCHIVE_DEPTH + 1,
      })
    ).toThrow('nested too deeply');
    expect(() => parseInventoryArchive('"\ud800"', runtime)).toThrow('valid UTF-8');
    expect(() => parseInventoryArchive('['.repeat(65) + '0' + ']'.repeat(65), runtime)).toThrow(
      'nested too deeply'
    );
  });

  it('rejects undeclared archive fields and source scope/schema disagreement', () => {
    const f = fixture();
    const extra = JSON.stringify({
      ...JSON.parse(f.artifact.sourceText),
      token: 'must-not-be-an-archive-field',
    });
    expect(() => parseInventoryArchive(extra, runtime)).toThrow('Expected exactly');
    expect(() =>
      parseInventoryArchive(
        rewritten(f.artifact.sourceText, (document) =>
          Object.assign(document.content.source, { storedSchema: 'dnaforge.inventory.v1' })
        ),
        runtime
      )
    ).toThrow('agree on schema');
  });
});

describe('deterministic archive adoption preview', () => {
  it('requires explicit admitted bindings and binds the exact source, target and fingerprints', () => {
    const f = fixture();
    const archive = parseInventoryArchive(f.artifact.sourceText, runtime);
    const input = previewInput(f);
    const before = structuredClone({ archive, input });
    const preview = inventoryImportPreview(archive, input, runtime);
    expect(preview.kind).toBe('ready');
    if (preview.kind !== 'ready') throw new Error('Expected ready preview.');
    expect(preview.options.bindings).toEqual(input.bindings.map(({ kind: _kind, ...row }) => row));
    expect(preview.responsibilities.activeReservationIds).toEqual(['hold']);
    expect(preview.records.find((row) => row.kind === 'stocks')?.ids).toEqual(['stock']);
    expect(
      inventoryImportPreview(archive, { ...input, asOf: input.asOf + 1000 }, runtime).planDigest
    ).toBe(preview.planDigest);
    expect(
      inventoryImportPreview(
        archive,
        {
          ...input,
          options: { bindings: [...input.options.bindings].reverse() },
          bindings: [...input.bindings].reverse(),
        },
        runtime
      ).planDigest
    ).toBe(preview.planDigest);
    expect(
      inventoryImportPreview(
        archive,
        { ...input, target: { ...input.target, inventoryId: 'different-target' } },
        runtime
      ).planDigest
    ).not.toBe(preview.planDigest);
    expect(
      inventoryImportPreview(
        archive,
        {
          ...input,
          bindings: input.bindings.map((row) => ({
            ...row,
            fingerprint: sha256('different accepted definition'),
          })),
        },
        runtime
      ).planDigest
    ).not.toBe(preview.planDigest);
    const whitespaceArchive = parseInventoryArchive(`${f.artifact.sourceText}\n`, runtime);
    expect(inventoryImportPreview(whitespaceArchive, input, runtime).planDigest).not.toBe(
      preview.planDigest
    );
    expect({ archive, input }).toEqual(before);
  });

  it('blocks missing, repeated, extraneous, collapsed and unavailable scientific bindings', () => {
    const f = fixture();
    const archive = parseInventoryArchive(f.artifact.sourceText, runtime);
    const input = previewInput(f);
    const cases: InventoryImportPreviewInput[] = [
      { ...input, options: { bindings: [] }, bindings: [] },
      { ...input, options: { bindings: [...input.options.bindings, input.options.bindings[0]] } },
      {
        ...input,
        options: {
          bindings: [
            ...input.options.bindings,
            { sourceMaterialId: 'not-in-source', destinationMaterialId: 'extra' },
          ],
        },
      },
      {
        ...input,
        options: {
          bindings: input.options.bindings.map((row) => ({
            ...row,
            destinationMaterialId: 'one-destination',
          })),
        },
      },
      {
        ...input,
        bindings: input.bindings.map((row) => ({
          sourceMaterialId: row.sourceMaterialId,
          destinationMaterialId: row.destinationMaterialId,
          kind: 'unavailable',
          reason: 'No current scientific admission',
        })),
      },
    ];
    expect(inventoryImportPreview(archive, cases[0], runtime).issues[0]).toMatchObject({
      code: 'UNRESOLVED_SCIENTIFIC_REFERENCE',
      pointer: '/content/scientificReferences/0/materialId',
    });
    for (const value of cases)
      expect(inventoryImportPreview(archive, value, runtime)).toMatchObject({
        kind: 'blocked',
        planDigest: null,
        options: null,
      });
  });

  it('blocks populated targets and future source clocks without generating an apply plan', () => {
    const f = fixture();
    const archive = parseInventoryArchive(f.artifact.sourceText, runtime);
    const input = previewInput(f);
    const populated = inventoryImportPreview(
      archive,
      { ...input, target: { ...input.target, present: true, revision: 1 } },
      runtime
    );
    expect(populated).toMatchObject({ kind: 'blocked', planDigest: null });
    expect(populated.issues[0]?.code).toBe('IMPORT_TARGET_POPULATED');
    const future = inventoryImportPreview(
      archive,
      { ...input, asOf: f.state.lastRecordedAt - 1 },
      runtime
    );
    expect(future).toMatchObject({ kind: 'blocked', planDigest: null });
    expect(future.issues[0]?.code).toBe('SOURCE_CLOCK_IN_FUTURE');
  });

  it('returns invalid source issues without manufacturing a source scope or usable plan', () => {
    const target = previewInput(fixture()).target;
    const preview = inventoryImportFailurePreview(
      '{"broken":',
      target,
      [{ code: 'INVALID_ARCHIVE_JSON', pointer: '', message: 'Invalid JSON' }],
      runtime
    );
    expect(preview).toMatchObject({
      kind: 'blocked',
      source: null,
      planDigest: null,
      sourceHistoryEntries: 0,
      records: [],
      issues: [{ code: 'INVALID_ARCHIVE_JSON' }],
    });
  });
});

it('passes inherited production refusal through old raw snapshots to descendant replay', () => {
  const f = fixture(1);
  const oldText = rewritten(f.artifact.sourceText, (document) => {
    const raw = JSON.parse(
      document.content.state.kind === 'present' ? document.content.state.json : 'null'
    );
    raw.schema = 'dnaforge.inventory.v28';
    delete raw.scientificProductions;
    const json = JSON.stringify(raw);
    Object.assign(document.content, {
      source: { ...document.content.source, storedSchema: raw.schema },
      state: { kind: 'present', json, sha256: sha256(json) },
    });
  });
  const replay = vi.fn((input: Parameters<InventoryArchiveRuntime['replayJournal']>[0]) =>
    runtime.replayJournal(input)
  );
  const checked = parseInventoryArchive(
    oldText,
    { ...runtime, replayJournal: replay },
    { allowScientificProductions: false }
  );
  expect(checked.state?.scientificProductions).toEqual({});
  expect(replay.mock.calls[0]?.[0].allowScientificProductions).toBe(false);
  expect(() =>
    parseInventoryArchive(f.artifact.sourceText, runtime, { allowScientificProductions: false })
  ).toThrow(/scientific productions/);
});
