import { beforeEach, expect, it, vi } from 'vitest';
import { settleImportedSequenceBindings } from './settle-imported-sequence-bindings';
import type { ResolvedManagedSequenceDocument } from './managed-sequence-repository-types';

const catalog = vi.hoisted(() => ({
  read: vi.fn(),
  register: vi.fn(),
  bind: vi.fn(),
}));
vi.mock('../../db/workspace-catalog', () => ({
  getCurrentSequenceFileForDocumentId: catalog.read,
  registerCatalogEntity: catalog.register,
  bindCatalogEntityToFile: catalog.bind,
}));

const id = '8a55ac70-b2a8-46d9-b19a-782974fcd2d2';
const root = '/project/imports/closed-sequence';
const imported = {
  ref: { kind: 'managed-sequence', packageId: id, packageRoot: root },
  document: { id, name: 'Closed sequence' },
  productPath: `${root}/sequence.gb`,
} as ResolvedManagedSequenceDocument;

beforeEach(() => {
  vi.resetAllMocks();
  catalog.register.mockResolvedValue({ id });
});

it('publishes the returned identity and waits until canonical lookup sees it', async () => {
  catalog.read
    .mockResolvedValueOnce(null)
    .mockResolvedValueOnce({ path: root, file_kind: 'waypoint-sequence' });
  await settleImportedSequenceBindings([imported], '/project');
  expect(catalog.register).toHaveBeenCalledWith(
    expect.objectContaining({ id, name: 'Closed sequence' })
  );
  expect(catalog.bind).toHaveBeenCalledWith(expect.objectContaining({ entityId: id, path: root }));
  expect(catalog.read).toHaveBeenCalledTimes(2);
});

it('fails when publication has not made its saved document resolvable', async () => {
  catalog.read.mockResolvedValue(null);
  await expect(settleImportedSequenceBindings([imported], '/project')).rejects.toThrow(
    'canonical lookup is not ready'
  );
});

it('preserves existing canonical ownership and refuses a conflicting binding', async () => {
  catalog.read.mockResolvedValue({
    path: '/project/another-package',
    file_kind: 'waypoint-sequence',
  });
  await expect(settleImportedSequenceBindings([imported], '/project')).rejects.toThrow(
    'another catalog binding'
  );
  expect(catalog.register).not.toHaveBeenCalled();
  expect(catalog.bind).not.toHaveBeenCalled();
});
