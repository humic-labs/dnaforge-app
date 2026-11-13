import { describe, expect, it, vi } from 'vitest';
import type { LimsRegistryPreview } from '../../shared/lims';
import type { EntityDetailsDefinition } from './types';
import { createEntityDetailsFactory } from './adapter-factory';

const preview = { entity: { id: 'entity-1' } } as LimsRegistryPreview;
const record = { id: 'entity-1' } as EntityDetailsDefinition['record'];
describe('the metadata adapter contract', () => {
  it('selects a native owner before the schema-backed fallback', async () => {
    const native = vi.fn(async () => ({ record }));
    const fallback = vi.fn(async () => ({ record }));
    const factory = createEntityDetailsFactory([
      { id: 'native', matches: () => true, create: native },
      { id: 'record', matches: () => true, create: fallback },
    ]);
    await factory(preview, { entityId: 'entity-1' });
    expect(native).toHaveBeenCalledOnce();
    expect(fallback).not.toHaveBeenCalled();
  });
  it('lets future schema-backed kinds inherit the same panel without a native adapter', async () => {
    const fallback = vi.fn(async () => ({ record }));
    const factory = createEntityDetailsFactory([
      { id: 'native', matches: () => false, create: vi.fn() },
      { id: 'record', matches: () => true, create: fallback },
    ]);
    await factory(
      { ...preview, entity: { ...preview.entity, kind: 'future_custom_kind' } },
      { entityId: 'entity-1' }
    );
    expect(fallback).toHaveBeenCalledOnce();
  });
  it('rejects duplicate owners and mismatched identities before writing anything', async () => {
    const adapter = { id: 'native', matches: () => true, create: vi.fn(async () => ({ record })) };
    expect(() => createEntityDetailsFactory([adapter, adapter])).toThrow('unique');
    await expect(
      createEntityDetailsFactory([adapter])(preview, { entityId: 'another' })
    ).rejects.toThrow('identity');
    expect(adapter.create).not.toHaveBeenCalled();
    adapter.create.mockResolvedValueOnce({ record: { ...record, id: 'another' } });
    await expect(
      createEntityDetailsFactory([adapter])(preview, { entityId: 'entity-1' })
    ).rejects.toThrow('different entity');
  });
});
