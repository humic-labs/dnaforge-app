import { createHash } from 'node:crypto';
import { expect, it, vi } from 'vitest';
import { createInventoryState, type InventoryArchiveRuntime } from './inventory';
import { applyInventoryCommandBatch } from './inventory-state';
import { createInventoryArchive, parseInventoryArchive } from './inventory-archive';
import { parseInventoryCommandBatch, parseInventoryState } from './inventory-validation';
import { organizationCommands, organizationFixture } from './inventory-organization.fixtures';
import { inventoryRunValueAttributionFixture } from './inventory-run-value-attribution.fixtures';
import { inventoryRunValueAttributionSelection } from './inventory-run-value-attribution-source';
import { inventoryProtocolRunSourceSha256 } from './inventory-scientific-source';
import {
  inventoryRunValueAttributionPreview,
  applyInventoryRunValueAttribution,
} from './inventory-run-value-attributions';
const hash = (text: string) => `sha256:${createHash('sha256').update(text).digest('hex')}` as const;
it('gates original raw formats without rewriting old local input', () => {
  const current = organizationFixture();
  expect(() => parseInventoryState(current, { allowOrganizationAuthority: false })).toThrow();
  const old = { ...current, schema: 'dnaforge.inventory.v30' },
    raw = JSON.stringify(old);
  expect(parseInventoryState(old, { allowOrganizationAuthority: false }).schema).toBe(
    'dnaforge.inventory.v31'
  );
  expect(JSON.stringify(old)).toBe(raw);
  const actor = organizationCommands(current, [
    {
      kind: 'reserve-quantity',
      id: 'hold',
      stockId: 'stock',
      quantity: { value: '1', unit: 'uL' },
      deadline: null,
      purpose: 'Use',
    },
  ]);
  expect(() => parseInventoryState({ ...actor, schema: 'dnaforge.inventory.v30' })).toThrow();
  expect(() =>
    parseInventoryState(
      { ...actor, schema: 'dnaforge.inventory.v30' },
      { allowOrganizationAuthority: false }
    )
  ).toThrow();
});
it('keeps account-shaped opaque Run row extras as data in old schema', () => {
  const f = inventoryRunValueAttributionFixture();
  const raw = JSON.parse(f.source.originalText);
  raw.outputs[0].vendorExtra = {
    kind: 'organization-account',
    orgId: 'opaque',
    accountId: 'opaque',
  };
  const source = { ...f.source, originalText: JSON.stringify(raw) };
  const runValue = { ...f.input.runValue, sourceSha256: inventoryProtocolRunSourceSha256(source) };
  const selected = inventoryRunValueAttributionSelection(source, runValue);
  const input = { ...f.input, source, runValue: selected.runValue };
  const preview = inventoryRunValueAttributionPreview(f.state, input);
  expect(preview.kind).toBe('ready');
  if (preview.kind !== 'ready') throw Error(JSON.stringify(preview));
  const result = applyInventoryRunValueAttribution(
    f.state,
    { ...input, expectedPlanDigest: preview.planDigest },
    f.context
  );
  if (!result.ok) throw Error(result.message);
  const old = { ...result.state, schema: 'dnaforge.inventory.v30' };
  expect(parseInventoryState(old, { allowOrganizationAuthority: false })).toEqual(result.state);
});
it('roundtrips current LOCAL archive and threads inherited false without granting organization scope', () => {
  const request = {
    expectedRevision: 0,
    commands: [
      { kind: 'create-vessel', id: 'empty', name: 'Empty', placement: { kind: 'unplaced' } },
    ],
  };
  const result = applyInventoryCommandBatch(
    createInventoryState(),
    parseInventoryCommandBatch(request)
  );
  if (!result.ok) throw Error(result.message);
  const runtime: InventoryArchiveRuntime = {
    maxBytes: 17 * 1024 * 1024,
    sha256: hash,
    replayJournal: vi.fn(({ rows }) => {
      let state = createInventoryState();
      for (const row of rows) {
        const r = applyInventoryCommandBatch(state, parseInventoryCommandBatch(row.request));
        if (!r.ok) throw Error(r.message);
        state = r.state;
      }
      return state;
    }),
  };
  const capture = {
    projectId: 'project',
    inventoryId: 'inventory',
    state: { revision: 1, json: JSON.stringify(result.state) },
    history: [
      { operationId: 'op', revision: 1, requestJson: JSON.stringify(request), receiptJson: '{}' },
    ],
  };
  const artifact = createInventoryArchive(capture, runtime);
  expect(parseInventoryArchive(artifact.sourceText, runtime).state).toEqual(result.state);
  expect(() =>
    parseInventoryArchive(artifact.sourceText, runtime, { allowOrganizationAuthority: false })
  ).toThrow();
  const legacy = createInventoryArchive(
    {
      ...capture,
      state: {
        revision: 1,
        json: JSON.stringify({ ...result.state, schema: 'dnaforge.inventory.v30' }),
      },
    },
    runtime
  );
  parseInventoryArchive(legacy.sourceText, runtime, { allowOrganizationAuthority: false });
  expect(runtime.replayJournal).toHaveBeenLastCalledWith(
    expect.objectContaining({ allowOrganizationAuthority: false })
  );
  const account = organizationCommands(organizationFixture(), [
    {
      kind: 'reserve-quantity',
      id: 'hold',
      stockId: 'stock',
      quantity: { value: '1', unit: 'uL' },
      deadline: null,
      purpose: 'Use',
    },
  ]);
  expect(() =>
    createInventoryArchive(
      { ...capture, state: { revision: account.revision, json: JSON.stringify(account) } },
      runtime
    )
  ).toThrow(/organization/);
});
