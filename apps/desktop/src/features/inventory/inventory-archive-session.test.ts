import { expect, it, vi } from 'vitest';
import type { InventoryExportSnapshot } from '../../shared/inventory-client';
import { unavailableInventoryClient } from '../../shared/inventory-client';
import { InventoryController } from './inventory-controller';
import { InventoryArchiveSession } from './inventory-archive-session';
import type { InventoryTextOutputPort } from './inventory-text-output';

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((accept) => {
    resolve = accept;
  });
  return { promise, resolve };
}

const source = { project: 'project-a', inventoryId: 'inventory-a' };
const archive = (
  projectId = source.project,
  inventoryId = source.inventoryId
): InventoryExportSnapshot => ({
  schema: 'dnaforge.inventory-export-artifact.v1',
  source: { projectId, inventoryId, revision: 7, storedSchema: 'dnaforge.inventory.v12' },
  sourceText: '{"retained":" 00123aBc ","unknown":null}\n',
  sourceSha256: `sha256:${'a'.repeat(64)}`,
  contentSha256: `sha256:${'b'.repeat(64)}`,
  asOf: 100,
  principal: { kind: 'local-profile', profileKey: 'synthetic' },
});

function fixture() {
  const artifact = archive();
  let saved = '';
  const port: InventoryTextOutputPort = {
    chooseDestination: vi.fn(async () => '/synthetic/inventory.json'),
    write: vi.fn(async (_path, content) => {
      saved = content;
    }),
    read: vi.fn(async () => saved),
  };
  const exportSnapshot = vi.fn(async () => artifact);
  const session = new InventoryArchiveSession(source, { exportSnapshot }, port);
  return { artifact, exportSnapshot, port, session, saved: () => saved };
}

it('captures one admitted source through the read client without choosing or writing output', async () => {
  const f = fixture();
  await f.session.capture();
  expect(f.exportSnapshot).toHaveBeenCalledWith({ ...source, format: 'native-v1' });
  expect(f.session.getSnapshot()).toEqual({
    capture: { kind: 'captured', artifact: f.artifact },
    output: { kind: 'not-exported' },
  });
  expect(f.port.chooseDestination).not.toHaveBeenCalled();
  expect(f.port.write).not.toHaveBeenCalled();
});

it('keeps cancellation separate from saved output and retains the captured bytes', async () => {
  const f = fixture();
  vi.mocked(f.port.chooseDestination).mockResolvedValueOnce(null);
  await f.session.capture();
  await f.session.exportArchive();
  expect(f.session.getSnapshot()).toEqual({
    capture: { kind: 'captured', artifact: f.artifact },
    output: { kind: 'not-exported' },
  });
  expect(f.port.write).not.toHaveBeenCalled();
  expect(f.port.read).not.toHaveBeenCalled();
  await f.session.exportArchive();
  expect(f.session.getSnapshot().output.kind).toBe('exported');
  expect(f.port.write).toHaveBeenCalledWith('/synthetic/inventory.json', f.artifact.sourceText);
  expect(f.exportSnapshot).toHaveBeenCalledOnce();
});

it('retains an uncertain write and confirms it without recapture or a second write', async () => {
  const f = fixture();
  vi.mocked(f.port.write).mockImplementationOnce(async (_path, content) => {
    vi.mocked(f.port.read).mockResolvedValue(content);
    throw new Error('Lost acknowledgement');
  });
  await f.session.capture();
  await f.session.exportArchive();
  expect(f.session.getSnapshot().output).toMatchObject({
    kind: 'output-unconfirmed',
    artifact: f.artifact,
    path: '/synthetic/inventory.json',
  });
  await f.session.capture();
  expect(f.exportSnapshot).toHaveBeenCalledOnce();
  await f.session.checkOutput();
  expect(f.session.getSnapshot().output.kind).toBe('exported');
  expect(f.port.write).toHaveBeenCalledOnce();
  expect(f.port.chooseDestination).toHaveBeenCalledOnce();
});

it('requires exact readback and retries the same archive at the retained destination', async () => {
  const f = fixture();
  const pending = deferred<string>();
  vi.mocked(f.port.read).mockReturnValueOnce(pending.promise);
  await f.session.capture();
  const exporting = f.session.exportArchive();
  await vi.waitFor(() => expect(f.session.getSnapshot().output.kind).toBe('confirming'));
  pending.resolve(f.artifact.sourceText.trimEnd());
  await exporting;
  expect(f.session.getSnapshot().output.kind).toBe('failed');
  await f.session.retryOutput();
  expect(f.session.getSnapshot().output.kind).toBe('exported');
  expect(f.port.write).toHaveBeenNthCalledWith(
    2,
    '/synthetic/inventory.json',
    f.artifact.sourceText
  );
  expect(f.port.chooseDestination).toHaveBeenCalledOnce();
  expect(f.exportSnapshot).toHaveBeenCalledOnce();
});

it('does not replace a capture while a destination or write is pending', async () => {
  const f = fixture();
  const choose = deferred<string | null>();
  vi.mocked(f.port.chooseDestination).mockReturnValueOnce(choose.promise);
  await f.session.capture();
  const exporting = f.session.exportArchive();
  expect(f.session.getSnapshot().output.kind).toBe('choosing');
  await f.session.capture();
  await f.session.exportArchive();
  expect(f.exportSnapshot).toHaveBeenCalledOnce();
  expect(f.port.chooseDestination).toHaveBeenCalledOnce();
  choose.resolve(null);
  await exporting;
  expect(f.session.getSnapshot().output.kind).toBe('not-exported');
});

it('keeps unreadable output unconfirmed until an explicit check or forget', async () => {
  const f = fixture();
  vi.mocked(f.port.read).mockRejectedValueOnce(new Error('Read unavailable'));
  await f.session.capture();
  await f.session.exportArchive();
  expect(f.session.getSnapshot().output.kind).toBe('output-unconfirmed');
  await f.session.capture();
  expect(f.exportSnapshot).toHaveBeenCalledOnce();
  f.session.forgetOutput();
  await f.session.capture();
  expect(f.exportSnapshot).toHaveBeenCalledTimes(2);
  expect(f.saved()).toBe(f.artifact.sourceText);
});

it('refuses a foreign scope and a native export failure without writing any file', async () => {
  const f = fixture();
  f.exportSnapshot.mockResolvedValueOnce(archive('other-project'));
  await f.session.capture();
  expect(f.session.getSnapshot().capture).toMatchObject({
    kind: 'failed',
    message: expect.stringContaining('another project'),
  });
  f.exportSnapshot.mockRejectedValueOnce(new Error('Current read grant refused'));
  await f.session.capture();
  expect(f.session.getSnapshot().capture).toEqual({
    kind: 'failed',
    message: 'Current read grant refused',
  });
  await f.session.exportArchive();
  expect(f.port.chooseDestination).not.toHaveBeenCalled();
  expect(f.port.write).not.toHaveBeenCalled();
});

it('discards a capture response after its session is disposed', async () => {
  const f = fixture();
  const pending = deferred<InventoryExportSnapshot>();
  f.exportSnapshot.mockReturnValueOnce(pending.promise);
  const capture = f.session.capture();
  f.session.dispose();
  pending.resolve(f.artifact);
  await capture;
  expect(f.session.getSnapshot().capture.kind).toBe('capturing');
  await f.session.exportArchive();
  expect(f.port.chooseDestination).not.toHaveBeenCalled();
});

it('keeps detached late output in its original full-scope session', async () => {
  const f = fixture();
  const client = {
    ...unavailableInventoryClient(),
    exportSnapshot: vi.fn(async (request) => archive(request.project, request.inventoryId)),
  };
  const controller = new InventoryController(client, { read: () => [], write: () => {} });
  const original = controller.archiveSession(source, f.port);
  const observed = vi.fn();
  const detach = original.subscribe(observed);
  await original.capture();
  const pending = deferred<void>();
  vi.mocked(f.port.write).mockImplementationOnce(async (_path, content) => {
    await pending.promise;
    vi.mocked(f.port.read).mockResolvedValue(content);
  });
  const exporting = original.exportArchive();
  await vi.waitFor(() => expect(original.getSnapshot().output.kind).toBe('writing'));
  detach();
  observed.mockClear();
  const other = controller.archiveSession({ ...source, inventoryId: 'other-inventory' }, f.port);
  await other.capture();
  pending.resolve();
  await exporting;
  expect(observed).not.toHaveBeenCalled();
  expect(controller.archiveSession(source, f.port)).toBe(original);
  expect(original.getSnapshot().output.kind).toBe('exported');
  expect(other.getSnapshot().output.kind).toBe('not-exported');
  expect(other.getSnapshot().capture).toMatchObject({
    kind: 'captured',
    artifact: { source: { inventoryId: 'other-inventory' } },
  });
  controller.dispose();
});
