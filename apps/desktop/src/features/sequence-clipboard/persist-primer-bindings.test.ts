import { describe, expect, it, vi } from 'vitest';
import type {
  PrimerBindingOwnership,
  PrimerBindingOwnershipStore,
} from './primer-binding-ownership';
import type { BoundPrimer, CreateBindingInput, Primer } from '../primers/types';
import { useSequenceStore } from '../sequence/public/store';
import { persistSequenceDocument } from '../sequence/public/persist-sequence-document';
vi.mock('../primers/public/primer-services', () => ({
  primerServices: { persistence: undefined },
}));
vi.mock('../../platform', () => ({
  platform: () => ({
    fs: {
      saveSequenceDocument: vi.fn(async () => ({ status: 'unbound' })),
      writeTextFile: vi.fn(async () => undefined),
      exists: vi.fn(async () => false),
    },
  }),
}));

import {
  persistRichPastePrimerBindings,
  type RichPastePrimerPersistence,
} from './persist-primer-bindings';

function primer(id: string, fileBacked: boolean): Primer {
  return {
    id,
    catalogNumber: id,
    name: id,
    sequence: 'ACGT',
    length: 4,
    tm: 50,
    gcPercent: 50,
    origin: 'manual',
    originDetails: fileBacked
      ? { authority: 'primer_artifact', artifactPath: `primers/${id}.primer.json` }
      : null,
    status: 'designed',
    vendor: null,
    orderDate: null,
    application: null,
    scale: null,
    purification: null,
    modifications: null,
    stockLocation: null,
    concentration: null,
    notes: null,
    workspaceId: null,
    createdAt: 1,
    updatedAt: 1,
  };
}

function persistence(primers: Record<string, Primer>): RichPastePrimerPersistence & {
  persistOwnedArtifactBindings: ReturnType<typeof vi.fn>;
  persistOwnedLegacyBinding: ReturnType<typeof vi.fn>;
  notifyBindingsChanged: ReturnType<typeof vi.fn>;
  ownership: PrimerBindingOwnershipStore;
} {
  const intents: PrimerBindingOwnership[] = [];
  return {
    ownership: {
      load: async (documentId, draftLineageId) =>
        intents.filter(
          (intent) => intent.documentId === documentId && intent.draftLineageId === draftLineageId
        ),
      record: async (intent) => {
        intents.push(intent);
      },
    },
    removeOwnedLegacyBinding: vi.fn(async () => undefined),
    listLegacyBoundPrimers: vi.fn(async () => []),
    readSavedTarget: vi.fn(async () => undefined),
    getPrimer: vi.fn(async (id: string) => primers[id] ?? null),
    persistOwnedArtifactBindings: vi.fn(async () => ({ bindingMutations: [] })),
    persistOwnedLegacyBinding: vi.fn(async (input) => ({
      ...input,
      id: input.bindingId,
      source: 'manual',
      createdAt: 1,
      updatedAt: 1,
    })),
    notifyBindingsChanged: vi.fn(),
  };
}

describe('persistRichPastePrimerBindings', () => {
  it('uses the file-authoritative attachment path for primer artifacts', async () => {
    const services = persistence({ 'primer-file': primer('primer-file', true) });

    await persistRichPastePrimerBindings(
      {
        bindings: [
          {
            pendingId: 'pending-file',
            primerId: 'primer-file',
            start: 12,
            end: 16,
            strand: -1,
            sourceWorkspaceRoot: '/workspace',
          },
        ],
        draftLineageId: 'test-lineage',
        expectedFileSha256: `sha256:${'0'.repeat(64)}`,
        targetDocumentId: 'test-document',
        targetFilePath: '/workspace/target.gb',
        targetSequenceId: 42,
        targetWorkspaceRoot: '/workspace',
      },
      services,
      services.ownership
    );

    expect(services.persistOwnedArtifactBindings).toHaveBeenCalledWith(
      expect.objectContaining({
        targetDocumentId: 'test-document',
        targetFilePath: '/workspace/target.gb',
        bindingSequenceId: 42,
        bindings: [expect.objectContaining({ start: 12, end: 16, strand: -1 })],
      })
    );
    expect(services.persistOwnedLegacyBinding).not.toHaveBeenCalled();
    expect(services.notifyBindingsChanged).toHaveBeenCalledWith(42);
  });

  it('uses the legacy projection only for a legacy primer and deduplicates repeated inputs', async () => {
    const services = persistence({ 'primer-legacy': primer('primer-legacy', false) });
    const binding = {
      pendingId: 'pending-legacy',
      primerId: 'primer-legacy',
      start: 3,
      end: 7,
      strand: 1 as const,
    };

    await persistRichPastePrimerBindings(
      {
        bindings: [binding, binding],
        draftLineageId: 'test-lineage',
        expectedFileSha256: `sha256:${'0'.repeat(64)}`,
        targetDocumentId: 'test-document',
        targetFilePath: '/workspace/target.gb',
        targetSequenceId: 42,
        targetWorkspaceRoot: '/workspace',
      },
      services,
      services.ownership
    );

    expect(services.persistOwnedLegacyBinding).toHaveBeenCalledTimes(1);
    expect(services.persistOwnedArtifactBindings).not.toHaveBeenCalled();
  });

  it('deduplicates an earlier save batch while persisting newly pasted bindings on retry', async () => {
    const first = primer('primer-a', false);
    const second = primer('primer-b', false);
    const services = persistence({ 'primer-a': first, 'primer-b': second });
    let existing: BoundPrimer[] = [];
    services.listLegacyBoundPrimers = vi.fn(async () => existing);
    const binding = {
      pendingId: 'pending-a',
      primerId: first.id,
      start: 0,
      end: 2,
      strand: 1 as const,
    };
    const context = {
      draftLineageId: 'test-lineage',
      expectedFileSha256: `sha256:${'0'.repeat(64)}`,
      targetDocumentId: 'document-binding-retry',
      targetFilePath: '/workspace/target.gb',
      targetSequenceId: 42,
      targetWorkspaceRoot: '/workspace',
    };

    await persistRichPastePrimerBindings(
      { ...context, bindings: [binding] },
      services,
      services.ownership
    );
    existing = [
      {
        ...first,
        binding: {
          id: 'existing-binding-a',
          primerId: first.id,
          sequenceId: 42,
          bindingStart: 0,
          bindingEnd: 2,
          strand: 1,
          source: 'manual',
          createdAt: 1,
          updatedAt: 1,
        },
      },
    ];
    await persistRichPastePrimerBindings(
      {
        ...context,
        bindings: [
          binding,
          { pendingId: 'pending-b', primerId: second.id, start: 6, end: 8, strand: -1 },
        ],
      },
      services,
      services.ownership
    );

    expect(services.persistOwnedLegacyBinding).toHaveBeenCalledTimes(2);
    expect(services.persistOwnedLegacyBinding).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        primerId: first.id,
        sequenceId: 42,
        bindingStart: 0,
        bindingEnd: 2,
        strand: 1,
      })
    );
    expect(services.persistOwnedLegacyBinding).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        primerId: second.id,
        sequenceId: 42,
        bindingStart: 6,
        bindingEnd: 8,
        strand: -1,
      })
    );
    expect(services.persistOwnedArtifactBindings).not.toHaveBeenCalled();
  });

  it('shifts an already attached pasted binding when a second paste precedes it during Save', async () => {
    const documentId = 'document-shifted-binding-retry';
    const first = primer('primer-a', false);
    const second = primer('primer-b', false);
    const services = persistence({ 'primer-a': first, 'primer-b': second });
    const stored: BoundPrimer[] = [];
    services.listLegacyBoundPrimers = vi.fn(async () => [...stored]);
    const primersById = new Map([
      [first.id, first],
      [second.id, second],
    ]);
    services.persistOwnedLegacyBinding.mockImplementation(
      async (input: CreateBindingInput & { bindingId: string }) => {
        const selected = primersById.get(input.primerId);
        if (!selected) throw new Error('Unknown primer in the controlled persistence fixture');
        const bound: BoundPrimer = {
          ...selected,
          binding: {
            id: input.bindingId,
            primerId: input.primerId,
            sequenceId: input.sequenceId,
            bindingStart: input.bindingStart,
            bindingEnd: input.bindingEnd,
            strand: input.strand,
            source: 'manual',
            createdAt: 1,
            updatedAt: 1,
          },
        };
        const index = stored.findIndex((row) => row.binding.id === input.bindingId);
        if (index < 0) stored.push(bound);
        else stored[index] = bound;
        return bound.binding;
      }
    );
    services.removeOwnedLegacyBinding = vi.fn(async ({ bindingId: id }: { bindingId: string }) => {
      const index = stored.findIndex((row) => row.binding.id === id);
      if (index >= 0) stored.splice(index, 1);
    });
    useSequenceStore.getState().setSequence(documentId, {
      id: documentId,
      name: 'shifted binding test',
      sequence: 'ATGC',
      length: 4,
      circular: false,
      annotations: [],
    });
    useSequenceStore.getState().dispatchEdit(documentId, { type: 'SET_CURSOR', position: 4 });
    useSequenceStore.getState().dispatchEdit(documentId, {
      type: 'INSERT_FRAGMENT',
      fragment: {
        sequence: 'AA',
        annotations: [],
        primerBindings: [{ primerId: first.id, start: 0, end: 2, strand: 1 }],
      },
    });
    let batches = 0;
    const result = await persistSequenceDocument({
      document: { documentId, sourcePath: '/workspace/target.gb' },
      persistPendingPrimerBindings: async (bindings, context) => {
        await persistRichPastePrimerBindings(
          {
            bindings,
            targetDocumentId: documentId,
            draftLineageId: context.draftLineageId,
            expectedFileSha256: context.expectedFileSha256,
            targetFilePath: '/workspace/target.gb',
            targetSequenceId: 42,
            targetWorkspaceRoot: '/workspace',
          },
          services,
          services.ownership
        );
        if (++batches === 1) {
          useSequenceStore.getState().dispatchEdit(documentId, { type: 'SET_CURSOR', position: 0 });
          useSequenceStore.getState().dispatchEdit(documentId, {
            type: 'INSERT_FRAGMENT',
            fragment: {
              sequence: 'CC',
              annotations: [],
              primerBindings: [{ primerId: second.id, start: 0, end: 2, strand: -1 }],
            },
          });
        }
      },
    });

    expect(result).toMatchObject({ ok: true, outcome: 'saved', attempts: 2, wrote: true });
    expect(useSequenceStore.getState().savedSequences[documentId]?.sequence).toBe('CCATGCAA');
    const attached = stored.map((row) => ({
      primerId: row.id,
      start: row.binding.bindingStart,
      end: row.binding.bindingEnd,
      strand: row.binding.strand,
    }));
    expect(attached, `retained binding rows: ${JSON.stringify(attached)}`).toEqual([
      { primerId: first.id, start: 6, end: 8, strand: 1 },
      { primerId: second.id, start: 0, end: 2, strand: -1 },
    ]);
  });

  it('fails closed instead of looking up a primer artifact in another project', async () => {
    const services = persistence({ 'primer-file': primer('primer-file', true) });

    await expect(
      persistRichPastePrimerBindings(
        {
          bindings: [
            {
              pendingId: 'pending-file',
              primerId: 'primer-file',
              start: 0,
              end: 4,
              strand: 1,
              sourceWorkspaceRoot: '/source-workspace',
            },
          ],
          draftLineageId: 'test-lineage',
          expectedFileSha256: `sha256:${'0'.repeat(64)}`,
          targetDocumentId: 'test-document',
          targetFilePath: '/target-workspace/target.gb',
          targetSequenceId: 42,
          targetWorkspaceRoot: '/target-workspace',
        },
        services,
        services.ownership
      )
    ).rejects.toThrow('cannot yet be transferred between projects');
    expect(services.persistOwnedArtifactBindings).not.toHaveBeenCalled();
  });
});
