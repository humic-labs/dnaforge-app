import { expect, it, vi } from 'vitest';
import {
  INVENTORY_LABEL_ENCODER,
  INVENTORY_LABEL_FONT,
} from '@waypoint/domain-services/inventory-label-types';
import {
  applyInventoryCommandBatch,
  createInventoryState,
  inventoryAvailability,
} from '@waypoint/domain-services';
import type {
  InventoryLabelArtifact,
  InventoryPrepareLabelRequest,
} from '../../shared/inventory-client';
import { unavailableInventoryClient } from '../../shared/inventory-client';
import { InventoryController } from './inventory-controller';
import { InventoryLabelSession, type InventoryLabelOutputPort } from './inventory-label-session';

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((accept) => {
    resolve = accept;
  });
  return { promise, resolve };
}

const source = { project: 'project', inventoryId: 'inventory', codeId: 'code' };

function artifact(
  request: InventoryPrepareLabelRequest = { ...source, mediaProfileId: 'qr-50x30-300dpi' }
): InventoryLabelArtifact {
  const principal = { kind: 'local-profile' as const, profileKey: 'synthetic' };
  const result = applyInventoryCommandBatch(
    createInventoryState(),
    {
      expectedRevision: 0,
      commands: [
        { kind: 'create-vessel', id: 'tube', name: 'Tube', placement: { kind: 'unplaced' } },
        {
          kind: 'attach-item-code',
          id: request.codeId,
          namespace: 'lab',
          value: ' 00123aBc ',
          item: { kind: 'vessel', id: 'tube' },
          reason: 'Synthetic code',
        },
      ],
    },
    { at: 1, principal, authority: principal }
  );
  if (!result.ok) throw new Error(result.message);
  const availability = inventoryAvailability(result.state, principal, 1);
  const binding = result.state.itemCodes[request.codeId];
  return {
    schema: 'dnaforge.inventory-label-artifact.v1',
    projectId: request.project,
    inventoryId: request.inventoryId,
    sourceRevision: result.state.revision,
    asOf: 1,
    principal,
    binding,
    target: {
      item: binding.item,
      record: result.state.vessels.tube,
      custody: availability.items.tube,
      physical: availability.physical.items.tube,
      currentLocationPath: null,
      stocks: [],
    },
    rendered: {
      spec: {
        scope: { projectId: request.project, inventoryId: request.inventoryId },
        sourceRevision: result.state.revision,
        binding,
        mediaProfileId: request.mediaProfileId,
      },
      template: 'dnaforge.inventory-label.qr.v1',
      encoder: INVENTORY_LABEL_ENCODER,
      font: INVENTORY_LABEL_FONT,
      media: {
        profileId: request.mediaProfileId,
        widthMm: 50,
        heightMm: 30,
        widthDots: 591,
        heightDots: 354,
        dpi: 300,
      },
      symbol: {
        symbology: 'qrcode',
        errorCorrection: 'M',
        modules: 21,
        dotsPerModule: 4,
        quietZoneModules: 4,
        xDots: 8,
        yDots: 8,
        sizeDots: 116,
      },
      humanText: [],
      svg: '<svg xmlns="http://www.w3.org/2000/svg"><path d="M0 0h4v4H0z"/></svg>',
    },
    svgSha256: `sha256:${'1'.repeat(64)}`,
  };
}

function fixture() {
  const copy = artifact();
  let saved: string | undefined;
  const prepareLabel = vi.fn(async (request: InventoryPrepareLabelRequest) => artifact(request));
  const port: InventoryLabelOutputPort = {
    chooseDestination: vi.fn(async () => '/synthetic/label.svg'),
    write: vi.fn(async (_path, content) => {
      saved = content;
    }),
    read: vi.fn(async () => {
      if (saved === undefined) throw new Error('No saved file');
      return saved;
    }),
  };
  const session = new InventoryLabelSession(source, { prepareLabel }, port);
  return { copy, port, prepareLabel, session, saved: () => saved };
}

it('discards a late rendering result after media changes without relabeling the new draft', async () => {
  const f = fixture();
  const pending = deferred<InventoryLabelArtifact>();
  f.prepareLabel.mockImplementationOnce(() => pending.promise);
  const first = f.session.prepare();
  f.session.selectMedia('qr-80x50-300dpi');
  await f.session.prepare();
  pending.resolve(f.copy);
  await first;
  expect(f.session.getSnapshot()).toMatchObject({
    mediaProfileId: 'qr-80x50-300dpi',
    preparation: {
      kind: 'rendered',
      artifact: { rendered: { spec: { mediaProfileId: 'qr-80x50-300dpi' } } },
    },
  });
});

it('does not write or claim an export after destination selection is canceled', async () => {
  const f = fixture();
  vi.mocked(f.port.chooseDestination).mockResolvedValueOnce(null);
  await f.session.prepare();
  await f.session.exportLabel();
  expect(f.session.getSnapshot().output).toEqual({ kind: 'not-exported' });
  expect(f.port.write).not.toHaveBeenCalled();
  expect(f.port.read).not.toHaveBeenCalled();
});

it('retains a lost write acknowledgement and confirms the exact file without rendering or writing again', async () => {
  const f = fixture();
  vi.mocked(f.port.write).mockImplementationOnce(async (_path, content) => {
    vi.mocked(f.port.read).mockResolvedValue(content);
    throw new Error('Acknowledgement lost');
  });
  await f.session.prepare();
  const prepared = f.session.getSnapshot().preparation;
  await f.session.exportLabel();
  expect(f.session.getSnapshot().output).toMatchObject({
    kind: 'output-unconfirmed',
    path: '/synthetic/label.svg',
    message: expect.stringContaining('Acknowledgement lost'),
  });
  f.session.selectMedia('qr-80x50-300dpi');
  await f.session.prepare();
  expect(f.session.getSnapshot().preparation).toBe(prepared);
  expect(f.session.getSnapshot().mediaProfileId).toBe('qr-50x30-300dpi');
  await f.session.checkOutput();
  expect(f.session.getSnapshot().output).toMatchObject({ kind: 'exported' });
  expect(f.prepareLabel).toHaveBeenCalledOnce();
  expect(f.port.write).toHaveBeenCalledOnce();
});

it('waits for exact readback and retries the retained bytes after an observed mismatch', async () => {
  const f = fixture();
  const pending = deferred<string>();
  vi.mocked(f.port.read).mockImplementationOnce(() => pending.promise);
  await f.session.prepare();
  const exporting = f.session.exportLabel();
  await vi.waitFor(() => expect(f.session.getSnapshot().output.kind).toBe('confirming'));
  pending.resolve('different file');
  await exporting;
  expect(f.session.getSnapshot().output.kind).toBe('failed');
  await f.session.retryOutput();
  expect(f.session.getSnapshot().output.kind).toBe('exported');
  expect(f.port.write).toHaveBeenNthCalledWith(2, '/synthetic/label.svg', f.copy.rendered.svg);
  expect(f.prepareLabel).toHaveBeenCalledOnce();
});

it('keeps unreadable output unconfirmed until an explicit check or forget', async () => {
  const f = fixture();
  vi.mocked(f.port.read).mockRejectedValueOnce(new Error('Readback unavailable'));
  await f.session.prepare();
  await f.session.exportLabel();
  expect(f.session.getSnapshot().output).toMatchObject({
    kind: 'output-unconfirmed',
    path: '/synthetic/label.svg',
  });
  f.session.forgetOutput();
  f.session.selectMedia('qr-80x50-300dpi');
  expect(f.session.getSnapshot()).toMatchObject({
    mediaProfileId: 'qr-80x50-300dpi',
    preparation: { kind: 'draft' },
    output: { kind: 'not-exported' },
  });
  expect(f.saved()).toBe(f.copy.rendered.svg);
});

it('keeps a detached view’s late output with its full scope and original code session', async () => {
  const f = fixture();
  const controller = new InventoryController(
    { ...unavailableInventoryClient(), prepareLabel: f.prepareLabel },
    { read: () => [], write: () => {} }
  );
  const original = controller.labelSession(source, f.port);
  expect(controller.hasLabelSnapshot(source)).toBe(false);
  const observed = vi.fn();
  const detach = original.subscribe(observed);
  await original.prepare();
  expect(controller.hasLabelSnapshot(source)).toBe(true);
  expect(controller.hasLabelSnapshot({ ...source, inventoryId: 'other-inventory' })).toBe(false);
  const pending = deferred<void>();
  vi.mocked(f.port.write).mockImplementationOnce(async (_path, content) => {
    await pending.promise;
    vi.mocked(f.port.read).mockResolvedValue(content);
  });
  const exporting = original.exportLabel();
  await vi.waitFor(() => expect(original.getSnapshot().output.kind).toBe('writing'));
  detach();
  observed.mockClear();
  const other = controller.labelSession({ ...source, project: 'other-project' }, f.port);
  const otherInventory = controller.labelSession(
    { ...source, inventoryId: 'other-inventory' },
    f.port
  );
  const otherCode = controller.labelSession({ ...source, codeId: 'other-code' }, f.port);
  await other.prepare();
  pending.resolve();
  await exporting;
  expect(observed).not.toHaveBeenCalled();
  expect(controller.labelSession(source, f.port)).toBe(original);
  expect(original.getSnapshot().output.kind).toBe('exported');
  expect(other.getSnapshot().output.kind).toBe('not-exported');
  expect(otherInventory).not.toBe(original);
  expect(otherCode).not.toBe(original);
  controller.dispose();
});

it('retains an unconfirmed destination when the same code view closes and reopens', async () => {
  const f = fixture();
  const controller = new InventoryController(
    { ...unavailableInventoryClient(), prepareLabel: f.prepareLabel },
    { read: () => [], write: () => {} }
  );
  const original = controller.labelSession(source, f.port);
  await original.prepare();
  vi.mocked(f.port.read).mockRejectedValueOnce(new Error('Readback unavailable'));
  await original.exportLabel();
  const reopened = controller.labelSession(source, f.port);
  expect(reopened.getSnapshot().output).toMatchObject({
    kind: 'output-unconfirmed',
    path: '/synthetic/label.svg',
    artifact: { rendered: { svg: f.copy.rendered.svg } },
  });
  await reopened.checkOutput();
  expect(reopened.getSnapshot().output.kind).toBe('exported');
  expect(f.prepareLabel).toHaveBeenCalledOnce();
  expect(f.port.write).toHaveBeenCalledOnce();
  controller.dispose();
});

it('rejects a response for another scope instead of previewing or exporting it', async () => {
  const f = fixture();
  f.prepareLabel.mockResolvedValueOnce({ ...f.copy, projectId: 'other-project' });
  await f.session.prepare();
  await f.session.exportLabel();
  expect(f.session.getSnapshot().preparation).toMatchObject({ kind: 'failed' });
  expect(f.port.chooseDestination).not.toHaveBeenCalled();
});
