import type { TrackViewCommand } from '@waypoint/domain-services';
import { describe, expect, it, vi } from 'vitest';
import { TrackViewCommands } from './track-view-commands';
import type { PreparedReferenceAssemblyEntryV1 } from '../shared/reference-assets-ipc';
import {
  validateTrackViewDocument,
  type SavedTrackView,
  type SaveTrackViewRequest,
} from '../shared/track-view';

const reference = {
  id: 'test-assembly',
  name: 'Test reference',
  organism: 'Synthetic',
  description: '',
  assetCacheKey: 'test-assembly',
  members: [
    { chrom: 'chr1', lengthBp: 1000 },
    { chrom: 'chr2', lengthBp: 2000 },
  ],
} as PreparedReferenceAssemblyEntryV1;

function fixture() {
  const files = new Map<string, SavedTrackView>();
  const save = vi.fn(async (input: SaveTrackViewRequest): Promise<SavedTrackView> => {
    const document = validateTrackViewDocument(input.document);
    if (files.has(document.id)) throw new Error('File exists');
    const saved = { document, ...input.destination!, revision: 'a'.repeat(64) };
    files.set(saved.document.id, saved);
    return saved;
  });
  const admit = vi.fn(async () => {
    throw new Error('Invalid signal source');
  });
  const assertWritable = vi.fn(async () => undefined);
  const commands = new TrackViewCommands({
    library: {
      save,
      read: async (id: string) => {
        const saved = files.get(id) ?? [...files.values()].find((entry) => entry.path === id);
        if (!saved) throw Object.assign(new Error('Missing'), { code: 'ENOENT' });
        return saved;
      },
    },
    resolveProject: async (project) => {
      if (project !== '/project') throw new Error('PROJECT_NOT_FOUND');
      return project;
    },
    references: async () => [reference],
    reference: async (id) => {
      if (id !== reference.id) throw new Error('REFERENCE_NOT_FOUND');
      return reference;
    },
    admit,
    assertWritable,
  });
  return { commands, files, save, admit, assertWritable };
}

const request = {
  operation: 'create' as const,
  project: '/project',
  referenceId: reference.id,
  requestId: 'cold-create',
  name: 'Native comparison',
  path: 'comparison.dnaforge-track-view.json',
  viewport: { chrom: 'chr2', start0: 0, end0: 100 },
  tracks: [],
};

describe('native Track View commands without a reference tab', () => {
  it('creates a durable view with assembly-relative coordinates and inspectable identity', async () => {
    const { commands, save } = fixture();
    const result = await commands.run(request);
    expect(result).toMatchObject({ ok: true, referenceId: reference.id, name: request.name });
    expect(save).toHaveBeenCalledWith(
      expect.objectContaining({
        expectedRevision: null,
        destination: {
          workspaceRoot: '/project',
          path: '/project/comparison.dnaforge-track-view.json',
        },
        document: expect.objectContaining({
          viewport: { start0: 1000, end0: 1100 },
          scope: { kind: 'chromosome', chrom: 'chr2' },
        }),
      })
    );
    const inspected = await commands.run({
      operation: 'inspect',
      project: '/project',
      path: result.path!,
    });
    expect(inspected).toMatchObject({ documentId: result.documentId, revision: result.revision });
  });

  it('reattaches an identical retry and refuses changed input without another write', async () => {
    const { commands, save } = fixture();
    const first = await commands.run(request);
    expect(await commands.run(request)).toEqual(first);
    await expect(commands.run({ ...request, name: 'Different' })).rejects.toThrow(
      /request|conflict/i
    );
    expect(save).toHaveBeenCalledTimes(1);
  });

  const invalidScopes: Array<Partial<Extract<TrackViewCommand, { operation: 'create' }>>> = [
    { path: '../outside.dnaforge-track-view.json' },
    { referenceId: 'missing' },
    { viewport: { chrom: 'chr2', start0: 0, end0: 2001 } },
    { viewport: { chrom: 'missing', start0: 0, end0: 20 } },
    { tracks: [{ source: { kind: 'path', path: '/outside/signal.bw' }, format: 'bigwig' }] },
  ];

  it.each(invalidScopes)('refuses invalid scope without publishing: %j', async (patch) => {
    const { commands, save } = fixture();
    await expect(commands.run({ ...request, ...patch })).rejects.toThrow();
    expect(save).not.toHaveBeenCalled();
  });

  it('refuses a readonly project before source admission or persistence', async () => {
    const { commands, assertWritable, admit, save } = fixture();
    assertWritable.mockRejectedValue(new Error('PROJECT_NOT_WRITABLE'));
    await expect(commands.run(request)).rejects.toThrow('PROJECT_NOT_WRITABLE');
    expect(admit).not.toHaveBeenCalled();
    expect(save).not.toHaveBeenCalled();
  });

  it('does not publish a partial document when source admission fails', async () => {
    const { commands, save } = fixture();
    await expect(
      commands.run({
        ...request,
        tracks: [
          { source: { kind: 'url', url: 'https://example.test/signal.bw' }, format: 'bigwig' },
        ],
      })
    ).rejects.toThrow('Invalid signal source');
    expect(save).not.toHaveBeenCalled();
  });
});
