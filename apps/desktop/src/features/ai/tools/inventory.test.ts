import { describe, expect, it } from 'vitest';
import {
  inventoryAgentSchema,
  inventoryAgentOutputSchema,
  inventoryAgentJsonSchema,
} from './inventory';

const operation = {
  kind: 'prepare-label',
  project: '/project',
  inventoryId: 'inventory',
  codeId: 'existing-code',
  mediaProfileId: 'qr-50x30-300dpi',
};

describe('inventory label agent contract', () => {
  it('admits only the bounded native preparation read without caller-authored identity or output', () => {
    expect(inventoryAgentSchema.parse({ operation })).toEqual({ operation });
    for (const extra of [
      { value: 'replacement alias' },
      { principal: { kind: 'agent', identityId: 'other' } },
      { asOf: 0 },
      { path: '/output.svg' },
      { templateId: 'arbitrary' },
      { mediaProfileId: 'printer-auto' },
    ])
      expect(
        inventoryAgentSchema.safeParse({ operation: { ...operation, ...extra } }).success
      ).toBe(false);
    const schema = JSON.stringify(inventoryAgentJsonSchema());
    expect(schema).toContain('prepare-label');
    expect(schema).toContain('qr-80x50-300dpi');
  });

  it('retains exact SVG bytes in the typed artifact result and refuses an unstructured success', () => {
    const output = {
      ok: true,
      kind: 'label-artifact',
      artifact: {
        sourceRevision: 2,
        binding: { namespace: 'lab', value: ' 00a^FNC1 ' },
        rendered: { svg: '<svg>exact bytes</svg>' },
      },
    };
    expect(inventoryAgentOutputSchema.parse(output)).toEqual(output);
    expect(inventoryAgentOutputSchema.safeParse({ ok: true, kind: 'label-artifact' }).success).toBe(
      false
    );
    expect(inventoryAgentOutputSchema.safeParse({ ...output, ok: false }).success).toBe(false);
  });
});

describe('inventory storage conditions agent contract', () => {
  const operation = {
    kind: 'storage-conditions',
    project: '/project',
    inventoryId: 'inventory',
    freshnessMaxAgeMs: null,
  };

  it('requires an explicit freshness policy and refuses a caller-authored clock or identity', () => {
    for (const freshnessMaxAgeMs of [null, 0, Number.MAX_SAFE_INTEGER])
      expect(
        inventoryAgentSchema.parse({ operation: { ...operation, freshnessMaxAgeMs } })
      ).toEqual({ operation: { ...operation, freshnessMaxAgeMs } });
    const { freshnessMaxAgeMs: _policy, ...missingPolicy } = operation;
    for (const invalid of [
      missingPolicy,
      ...[-1, 1.5, Number.MAX_SAFE_INTEGER + 1, '100'].map((freshnessMaxAgeMs) => ({
        ...operation,
        freshnessMaxAgeMs,
      })),
      { ...operation, asOf: 0 },
      { ...operation, principal: { kind: 'agent', identityId: 'other' } },
    ])
      expect(inventoryAgentSchema.safeParse({ operation: invalid }).success).toBe(false);
    expect(JSON.stringify(inventoryAgentJsonSchema())).toContain('storage-conditions');
  });

  it('retains the independently named assessments in a conditions result', () => {
    const output = {
      ok: true,
      kind: 'storage-conditions',
      conditions: {
        revision: 7,
        asOf: 100,
        freshnessMaxAgeMs: null,
        stocks: {
          stock: {
            capability: { state: 'supported', claimIds: ['source-claim'] },
            reportedTarget: { state: 'incompatible', claimIds: [] },
            qualifiedSupport: { state: 'unknown', claimIds: [] },
          },
        },
      },
    };
    expect(inventoryAgentOutputSchema.parse(output)).toEqual(output);
    expect(
      inventoryAgentOutputSchema.safeParse({ ok: true, kind: 'storage-conditions' }).success
    ).toBe(false);
  });
});

describe('inventory portability agent contract', () => {
  const scope = { project: '/project', inventoryId: 'inventory' };
  it('separates untrusted preview choices from resolved adoption bindings and refuses native authority fields', () => {
    const preview = { kind: 'preview-import', ...scope, sourceText: 'archive', options: { bindings: [{ sourceMaterialId: 'source', destinationMaterialId: 'destination' }] } };
    expect(inventoryAgentSchema.parse({ operation: preview })).toEqual({ operation: preview });
    const operation = { kind: 'apply-import', ...scope, operationId: 'adopt', expectedRevision: 0, sourceText: 'archive', options: { bindings: [{ sourceMaterialId: 'source', destinationMaterialId: 'destination', fingerprint: `sha256:${'0'.repeat(64)}` }] }, expectedPlanDigest: `sha256:${'1'.repeat(64)}` };
    expect(inventoryAgentSchema.parse({ operation })).toEqual({ operation });
    for (const extra of [{ principal: { kind: 'agent', identityId: 'foreign' } }, { recordedAt: 0 }, { authority: { kind: 'local-profile', profileKey: '0'.repeat(64) } }])
      expect(inventoryAgentSchema.safeParse({ operation: { ...operation, ...extra } }).success).toBe(false);
    expect(inventoryAgentSchema.safeParse({ operation: { ...operation, options: preview.options } }).success).toBe(false);
    expect(inventoryAgentSchema.safeParse({ operation: { ...preview, options: operation.options } }).success).toBe(false);
  });
});

describe('inventory receive table agent contract', () => {
  const options = { namespace: 'source', delimiter: ',', materials: [{ key: '001', materialId: 'material' }], locations: [], vessels: [], skips: [] };
  const preview = { kind: 'preview-table', project: '/project', inventoryId: 'inventory', format: 'receive-v1', sourceText: 'exact source\r\n', options };
  it('requires resolved material fingerprints only at acceptance and excludes authored authority', () => {
    expect(inventoryAgentSchema.parse({ operation: preview })).toEqual({ operation: preview });
    const operation = { kind: 'apply-table', project: '/project', inventoryId: 'inventory', operationId: 'table-once', expectedRevision: 0, sourceText: preview.sourceText, options: { ...options, materials: [{ ...options.materials[0], fingerprint: `sha256:${'0'.repeat(64)}` }] }, expectedPlanDigest: `sha256:${'1'.repeat(64)}` };
    expect(inventoryAgentSchema.parse({ operation })).toEqual({ operation });
    expect(inventoryAgentSchema.safeParse({ operation: { ...operation, options } }).success).toBe(false);
    expect(inventoryAgentSchema.safeParse({ operation: { ...preview, options: operation.options } }).success).toBe(false);
    for (const extra of [{ recordedAt: 0 }, { principal: { kind: 'agent', identityId: 'other' } }, { authority: { kind: 'local-profile', profileKey: '0'.repeat(64) } }])
      expect(inventoryAgentSchema.safeParse({ operation: { ...operation, ...extra } }).success).toBe(false);
    expect(inventoryAgentOutputSchema.parse({ ok: true, kind: 'table-preview', preview: { kind: 'blocked', rows: [] } })).toMatchObject({ kind: 'table-preview' });
    expect(inventoryAgentOutputSchema.safeParse({ ok: true, kind: 'table-preview' }).success).toBe(false);
  });
});
