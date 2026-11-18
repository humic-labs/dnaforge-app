import { createRegisteredProjectAuthorityFixture } from '../../main/__tests__/registered-project-authority-fixture';
// @vitest-environment node

import { createHash } from 'node:crypto';
import { mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  ensureManagedGenBankAnnotationIds,
  listManagedGenBankAnnotations,
  serializeSequenceForInPlaceSave,
} from '@waypoint/sequence-utils';
import {
  NativeSequenceWorkingCopyOwner,
  type NativeSequenceRecord,
  type NativeSequenceScope,
  type NativeSequenceSaveScope,
} from '../../main/native-sequence-working-copy';
import { writeTextFileAtomicInMain } from '../../main/text-file-atomic';
import { parseSequenceFileAsDocument } from '../../shared/parse-sequence-file';
import { createSequenceDocumentModel, type SequenceSaveCapture } from './sequence-document-model';
import { SequenceDocumentClientBridge } from './sequence-document-client';
import { sequenceDocumentInspectSchema } from '../../shared/sequence-document';
import { NativeDocumentWorkspaces } from '../../main/native-document-workspaces';
import type { SequenceDocumentSaveCaptureInput } from '../../shared/sequence-edit-lineage';

const port = vi.hoisted(() => ({ execute: vi.fn(), available: vi.fn() }));
vi.mock('../../platform', () => ({
  platform: () => ({
    fs: { sequenceDocument: port.execute, isSequenceDocumentAvailable: port.available },
  }),
}));
const directories: string[] = [];
const inspect = sequenceDocumentInspectSchema.parse({ kind: 'inspect' });
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((complete) => {
    resolve = complete;
  });
  return { promise, resolve };
}
afterEach(async () => {
  port.execute.mockReset();
  port.available.mockReset();
  await Promise.all(
    directories.splice(0).map((path) => rm(path, { recursive: true, force: true }))
  );
});

async function fixture(
  pause?: () => Promise<void>,
  managed = false,
  options: {
    readOnly?: boolean;
    assertResolve?: () => void;
    accepted?: boolean;
    captureWorkspace?: (root: string) => () => void;
    assertSavedResource?: () => void;
    persistPendingPrimerBindings?: (capture: SequenceSaveCapture) => Promise<void>;
  } = {}
) {
  port.available.mockResolvedValue(true);
  const root = await realpath(await mkdtemp(join(tmpdir(), 'sequence-native-client-')));
  directories.push(root);
  const path = join(root, 'sequence.gb'),
    id = 'sequence-native-client';
  const initial = {
    id,
    name: 'Client',
    sequence: 'AAAACCCC',
    length: 8,
    annotations: [],
    circular: false,
    metadata: {},
  };
  await writeFile(path, serializeSequenceForInPlaceSave(initial, path));
  const records = new Map<string, NativeSequenceRecord>(),
    writes = vi.fn();
  const captures: SequenceDocumentSaveCaptureInput[] = [];
  const digest = async () =>
    `sha256:${createHash('sha256')
      .update(await readFile(path))
      .digest('hex')}`;
  const owner = new NativeSequenceWorkingCopyOwner({
    resolve: async () => {
      options.assertResolve?.();
      const scope: NativeSequenceScope = {
        documentId: id,
        path,
        workspaceRoot: root,
        readOnly: options.readOnly ?? false,
        managed,
        assertCurrent: options.captureWorkspace?.(root) ?? (() => {}),
        captureForSave(): NativeSequenceSaveScope {
          scope.assertCurrent();
          return { ...scope, assertCurrent: options.assertSavedResource ?? (() => {}) };
        },
      };
      return scope;
    },
    load: async () => ({
      sequence: parseSequenceFileAsDocument(await readFile(path, 'utf8'), path).sequence,
      sha256: await digest(),
      ...(options.accepted
        ? {
            acceptedRevision: {
              kind: 'accepted-object' as const,
              contentSha256: (await digest()).slice('sha256:'.length),
              resourceId: id,
              resourceRevisionId: 'accepted-resource-revision',
              workspaceVersionId: 'accepted-workspace-version',
              sequenceEditParentEventId: null,
            },
          }
        : {}),
    }),
    readSha256: digest,
    persistPendingPrimerBindings: options.persistPendingPrimerBindings,
    loadRecord: async (documentId) => records.get(documentId),
    storeRecord: async (record) => {
      records.set(record.documentId, structuredClone(record));
    },
    save: async (input, _scope, baseline) => {
      captures.push(structuredClone(input.capture));
      writes();
      if (pause) await pause();
      const serialized = serializeSequenceForInPlaceSave(input.capture.sequence, path);
      const content = managed
        ? ensureManagedGenBankAnnotationIds(
            serialized,
            () => 'a17cb951-4250-447e-8d52-2d1163104775',
            await readFile(path, 'utf8')
          )
        : serialized;
      await writeTextFileAtomicInMain({
        path,
        content,
        expectedContentHash: baseline,
      });
      const fileSha256 = await digest();
      return {
        result: {
          status: 'saved',
          fileSha256,
          eventId: null,
          lineage: 'unavailable',
          ...(managed
            ? { managedAnnotationIds: listManagedGenBankAnnotations(content).map(({ id }) => id) }
            : {}),
        },
        fileSha256,
      };
    },
  });
  port.execute.mockImplementation(async (request) => structuredClone(await owner.execute(request)));
  let bridge!: SequenceDocumentClientBridge;
  const model = createSequenceDocumentModel({
    beforeInput: (documentId, purpose) => bridge.assertInput(documentId, purpose),
    afterCommand: (command) => bridge.command(command),
  });
  bridge = new SequenceDocumentClientBridge(model);
  owner.subscribe((snapshot) => bridge.observe(structuredClone(snapshot)));
  return { owner, model, bridge, id, root, path, initial, records, writes, captures };
}

it.each(['input', 'execute', 'save', 'reconnect'] as const)(
  'refuses fresh sequence %s after retirement without another native command',
  async (operation) => {
    const f = await fixture();
    f.model.getState().setSequence(f.id, f.initial);
    await f.bridge.flush();
    const capture = f.model.getState().captureForSave(f.id)!;
    await f.bridge.flush('retire');
    port.execute.mockClear();
    port.available.mockClear();
    try {
      const attempts = {
        input: () => f.model.getState().replaceBases(f.id, 0, 1, 'T'),
        execute: () => f.bridge.execute(f.id, inspect),
        save: () => f.bridge.save(f.id, { capture }),
        reconnect: () => f.bridge.command({ method: 'setSequence', args: [f.id, f.initial] }),
      };
      await expect(
        Promise.resolve().then(async () => {
          await attempts[operation]();
        })
      ).rejects.toThrow('SEQUENCE_DOCUMENT_CLIENT_RETIRED');
      f.bridge.refreshAvailableDocuments();
      await Promise.resolve();
      expect(port.execute).not.toHaveBeenCalled();
      expect(port.available).not.toHaveBeenCalled();
      expect(f.writes).not.toHaveBeenCalled();
      expect(f.model.getState().sequences[f.id].sequence).toBe('AAAACCCC');
    } finally {
      await f.bridge.flush('discard');
      await f.owner.close();
    }
  }
);

it('retires a deferred reconciliation refresh without starting another native load', async () => {
  const f = await fixture();
  const entered = deferred();
  const release = deferred();
  port.available.mockImplementationOnce(async () => {
    entered.resolve();
    await release.promise;
    return false;
  });
  f.model.getState().setSequence(f.id, f.initial);
  await entered.promise;
  f.bridge.refreshAvailableDocuments();
  const retirement = f.bridge.flush('retire');
  try {
    release.resolve();
    await retirement;
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(port.available).toHaveBeenCalledOnce();
    expect(port.execute).not.toHaveBeenCalled();
    expect(f.writes).not.toHaveBeenCalled();
    expect(f.bridge.isInputPending(f.id)).toBe(true);
  } finally {
    release.resolve();
    await retirement;
    await f.owner.close();
  }
});

it('retires rejected sequence input without requiring a clean synchronization or reconnecting', async () => {
  const f = await fixture();
  f.model.getState().setSequence(f.id, f.initial);
  await f.bridge.flush();
  const original = await readFile(f.path);
  const refused = new Error('Original native sequence mutation refused');
  const execute = port.execute.getMockImplementation()!;
  port.execute.mockImplementation(async (request) => {
    if (request.operation.kind === 'client-command') throw refused;
    return execute(request);
  });
  const log = vi.spyOn(console, 'error').mockImplementation(() => {});
  try {
    f.model.getState().replaceBases(f.id, 0, 1, 'T');
    await expect(f.bridge.flush()).rejects.toBe(refused);
    await expect(f.bridge.flush('retire')).resolves.toBeUndefined();
    await expect(f.bridge.flush()).rejects.toBe(refused);
    expect(f.model.getState().sequences[f.id].sequence).toBe('TAAACCCC');
    expect(await readFile(f.path)).toEqual(original);
    expect(f.writes).not.toHaveBeenCalled();
    expect(log).toHaveBeenCalledWith('[Native sequence document]', refused, 'command=replaceBases');
    port.execute.mockClear();
    port.available.mockClear();
    f.bridge.refreshAvailableDocuments();
    await Promise.resolve();
    expect(port.execute).not.toHaveBeenCalled();
    expect(port.available).not.toHaveBeenCalled();
  } finally {
    log.mockRestore();
    await f.bridge.flush('discard');
    await f.owner.close();
  }
});

it('completes an already admitted sequence publication before retirement closes its native owner', async () => {
  const entered = deferred();
  const release = deferred();
  const f = await fixture(async () => {
    entered.resolve();
    await release.promise;
  });
  f.model.getState().setSequence(f.id, f.initial);
  await f.bridge.flush();
  f.model.getState().replaceBases(f.id, 0, 1, 'T');
  await f.bridge.flush();
  const capture = f.model.getState().captureForSave(f.id)!;
  const saving = f.bridge.save(f.id, { capture });
  await entered.promise;
  let retired = false;
  const retirement = f.bridge.flush('retire').then(() => {
    retired = true;
  });
  try {
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(retired).toBe(false);
    release.resolve();
    expect(await saving).toMatchObject({ saved: true });
    await retirement;
    await f.owner.close();
    expect(
      parseSequenceFileAsDocument(await readFile(f.path, 'utf8'), f.path).sequence.sequence
    ).toBe('TAAACCCC');
    expect(f.writes).toHaveBeenCalledOnce();
    port.execute.mockClear();
    await expect(f.bridge.execute(f.id, inspect)).rejects.toThrow(
      'SEQUENCE_DOCUMENT_CLIENT_RETIRED'
    );
    expect(port.execute).not.toHaveBeenCalled();
  } finally {
    release.resolve();
    await Promise.allSettled([saving, retirement]);
    await f.owner.close();
  }
});

describe('sequence UI input client of native owner', () => {
  it('coalesces a reconciliation refresh behind an in-flight unavailable scope check', async () => {
    const f = await fixture();
    const check = deferred();
    port.available.mockImplementationOnce(async () => {
      await check.promise;
      return false;
    });
    f.model.getState().setSequence(f.id, f.initial);
    await vi.waitFor(() => expect(port.available).toHaveBeenCalledOnce());
    f.bridge.refreshAvailableDocuments();
    f.bridge.refreshAvailableDocuments();
    check.resolve();
    await f.bridge.flush();
    expect(f.bridge.isInputPending(f.id)).toBe(false);
    expect(() => f.bridge.assertInput(f.id)).not.toThrow();
    expect(port.available).toHaveBeenCalledTimes(2);
    expect(port.execute).toHaveBeenCalledWith(
      expect.objectContaining({
        documentId: f.id,
        operation: expect.objectContaining({ kind: 'inspect' }),
      })
    );
    expect(f.writes).not.toHaveBeenCalled();
    await f.owner.close();
  });

  it('does not reattach a cleared document when a queued reconciliation refresh settles', async () => {
    const f = await fixture();
    const check = deferred();
    port.available.mockImplementationOnce(async () => {
      await check.promise;
      return false;
    });
    f.model.getState().setSequence(f.id, f.initial);
    await vi.waitFor(() => expect(port.available).toHaveBeenCalledOnce());
    f.bridge.refreshAvailableDocuments();
    f.model.getState().clearSequence(f.id);
    check.resolve();
    await f.bridge.flush();
    expect(f.bridge.owns(f.id)).toBe(false);
    expect(f.model.getState().sequences[f.id]).toBeUndefined();
    expect(port.available).toHaveBeenCalledOnce();
    expect(port.execute).not.toHaveBeenCalled();
    expect(f.writes).not.toHaveBeenCalled();
    await f.owner.close();
  });

  it('does not admit an unknown Track View discard or poison the loaded plasmid client', async () => {
    const f = await fixture();
    f.model.getState().setSequence(f.id, f.initial);
    await f.bridge.flush();
    const accepted = f.model.getState().sequences[f.id];
    const bytes = await readFile(f.path);
    const execute = port.execute.getMockImplementation()!;
    port.execute.mockClear();
    port.execute.mockImplementation((request) =>
      request.documentId === f.id
        ? execute(request)
        : Promise.reject(new Error('The sequence has no unique owning project.'))
    );
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const unknown = 'track-view-draft-02a8dc44-585f-4a7d-b0d6-cb9bd808634d';
      expect(f.model.getState().discardEdits(unknown)).toBeNull();
      await expect(f.bridge.flush()).resolves.toBeUndefined();
      expect(f.bridge.owns(unknown)).toBe(false);
      expect(port.execute).not.toHaveBeenCalled();
      expect(log).not.toHaveBeenCalled();
      expect(f.model.getState().sequences[f.id]).toEqual(accepted);
      expect(await readFile(f.path)).toEqual(bytes);
      expect(f.writes).not.toHaveBeenCalled();
    } finally {
      log.mockRestore();
      await f.owner.close();
    }
  });

  it('retains optimistic primer intent identities through native admission and gives another paste fresh identities', async () => {
    const f = await fixture();
    f.model.getState().setSequence(f.id, f.initial);
    await f.bridge.flush();
    const entered = deferred();
    const release = deferred();
    port.execute.mockImplementation(async (request) => {
      if (
        request.operation.kind === 'client-command' &&
        request.operation.command.method === 'dispatchEdit' &&
        request.operation.command.action.type === 'INSERT_FRAGMENT'
      ) {
        entered.resolve();
        await release.promise;
      }
      return structuredClone(await f.owner.execute(request));
    });
    const fragment = {
      sequence: 'AT',
      annotations: [],
      primerBindings: [
        { primerId: 'primer-one', start: 0, end: 1, strand: 1 as const },
        { primerId: 'primer-two', start: 1, end: 2, strand: -1 as const },
      ],
    };
    f.model.getState().dispatchEdit(f.id, { type: 'INSERT_FRAGMENT', fragment });
    const optimistic = f.model.getState().captureForSave(f.id)?.pendingPrimerBindings;
    expect(optimistic).toHaveLength(2);
    try {
      await entered.promise;
      release.resolve();
      await f.bridge.flush();
      expect(f.model.getState().captureForSave(f.id)?.pendingPrimerBindings).toEqual(optimistic);
      f.model.getState().dispatchEdit(f.id, { type: 'INSERT_FRAGMENT', fragment });
      const repeated = f.model.getState().captureForSave(f.id)?.pendingPrimerBindings;
      expect(repeated).toHaveLength(4);
      expect(new Set(repeated?.map((binding) => binding.pendingId)).size).toBe(4);
      await f.bridge.flush();
      expect(f.model.getState().captureForSave(f.id)?.pendingPrimerBindings).toEqual(repeated);
      expect(fragment.primerBindings.every((binding) => !('pendingId' in binding))).toBe(true);
    } finally {
      release.resolve();
      await f.bridge.flush();
      await f.owner.close();
    }
  });
  it('carries a confirmed partial primer write through cloned native replies and retries against its published hash', async () => {
    let blocked = true;
    const bindings = vi.fn(async () => {
      if (blocked) throw new Error('Owned primer binding denied after product write');
    });
    const f = await fixture(undefined, false, { persistPendingPrimerBindings: bindings });
    let admittedCaptureId: string | undefined;
    port.execute.mockImplementation(async (request) => {
      const snapshot = structuredClone(await f.owner.execute(request));
      if (request.operation.kind === 'capture-save') admittedCaptureId = snapshot.captureId;
      return snapshot;
    });
    f.model.getState().setSequence(f.id, f.initial);
    await f.bridge.flush();
    f.model.getState().dispatchEdit(f.id, {
      type: 'INSERT_FRAGMENT',
      fragment: {
        sequence: 'AT',
        annotations: [],
        primerBindings: [{ primerId: 'owned-primer', start: 0, end: 2, strand: 1 }],
      },
    });
    await f.bridge.flush();
    const first = f.model.getState().captureForSave(f.id);
    if (!first) throw new Error('Missing native primer capture');
    try {
      const partial = await f.bridge.save(f.id, { capture: first });
      expect(partial).toMatchObject({
        saved: true,
        dirty: true,
        primerBindingFailure: { message: 'Owned primer binding denied after product write' },
      });
      expect(partial.captureId).toBeUndefined();
      if (!admittedCaptureId) throw new Error('Missing admitted partial capture');
      await expect(
        f.owner.execute({
          documentId: f.id,
          expectedVersion: partial.version,
          operation: {
            kind: 'capture-save',
            message: 'Edit sequence',
            fromCaptureId: admittedCaptureId,
          },
          projection: 'document',
        })
      ).rejects.toThrow('STALE_SEQUENCE_SAVE_CONTINUATION');
      expect(f.model.getState().captureForSave(f.id)).toEqual(first);
      expect(f.model.getState().savedSequences[f.id].sequence).toBe(f.initial.sequence);
      expect(f.records.get(f.id)?.baselineSha256).toBe(
        `sha256:${createHash('sha256')
          .update(await readFile(f.path))
          .digest('hex')}`
      );
      blocked = false;
      f.model.getState().dispatchEdit(f.id, { type: 'INSERT', text: 'G' });
      await f.bridge.flush();
      const newer = f.model.getState().captureForSave(f.id);
      if (!newer) throw new Error('Missing newer native primer capture');
      const completed = await f.bridge.save(f.id, { capture: newer });
      expect(completed).toMatchObject({ saved: true, dirty: false, version: newer.revision });
      expect(completed.primerBindingFailure).toBeUndefined();
      expect(f.model.getState().captureForSave(f.id)?.pendingPrimerBindings).toEqual([]);
      expect(f.model.getState().sequences[f.id].sequence).toBe('ATGAAAACCCC');
      expect(
        parseSequenceFileAsDocument(await readFile(f.path, 'utf8'), f.path).sequence.sequence
      ).toBe('ATGAAAACCCC');
      expect(f.writes).toHaveBeenCalledTimes(2);
      expect(bindings).toHaveBeenCalledTimes(2);
    } finally {
      await f.owner.close();
    }
  });
  it('refuses a partial snapshot after captured resource authority is revoked', async () => {
    let writable = true;
    const f = await fixture(undefined, false, {
      assertSavedResource: () => {
        if (!writable) throw new Error('Saved resource authority revoked');
      },
      persistPendingPrimerBindings: async () => {
        writable = false;
        throw new Error('Owned primer binding denied');
      },
    });
    f.model.getState().setSequence(f.id, f.initial);
    await f.bridge.flush();
    f.model.getState().dispatchEdit(f.id, { type: 'INSERT', text: 'AT' });
    await f.bridge.flush();
    const capture = f.model.getState().captureForSave(f.id);
    if (!capture) throw new Error('Missing native Save capture');
    try {
      await expect(f.bridge.save(f.id, { capture })).rejects.toThrow(
        'Saved resource authority revoked'
      );
      expect(f.model.getState().captureForSave(f.id)).toEqual(capture);
      expect(f.writes).toHaveBeenCalledOnce();
    } finally {
      await f.owner.close();
    }
  });
  it('refuses a partial acknowledgement if the published file changes during primer settlement', async () => {
    let path = '';
    const f = await fixture(undefined, false, {
      persistPendingPrimerBindings: async () => {
        await writeFile(path, (await readFile(path, 'utf8')) + '\n');
        throw new Error('Owned primer binding denied');
      },
    });
    path = f.path;
    f.model.getState().setSequence(f.id, f.initial);
    await f.bridge.flush();
    f.model.getState().dispatchEdit(f.id, { type: 'INSERT', text: 'AT' });
    await f.bridge.flush();
    const capture = f.model.getState().captureForSave(f.id);
    if (!capture) throw new Error('Missing native Save capture');
    try {
      await expect(f.bridge.save(f.id, { capture })).rejects.toThrow('FILE_CHANGED');
      expect(f.model.getState().captureForSave(f.id)).toEqual(capture);
      expect(f.writes).toHaveBeenCalledOnce();
    } finally {
      await f.owner.close();
    }
  });
  it('keeps direct native Save failed with its known product write receipt', async () => {
    const f = await fixture(undefined, false, {
      persistPendingPrimerBindings: async () => {
        throw new Error('Owned primer binding denied');
      },
    });
    f.model.getState().setSequence(f.id, f.initial);
    await f.bridge.flush();
    f.model.getState().dispatchEdit(f.id, { type: 'INSERT', text: 'AT' });
    await f.bridge.flush();
    const capture = f.model.getState().captureForSave(f.id);
    if (!capture) throw new Error('Missing native Save capture');
    try {
      await expect(
        f.owner.execute({
          documentId: f.id,
          expectedVersion: capture.revision,
          operation: { kind: 'save', message: 'Edit sequence' },
          projection: 'inspection',
        })
      ).rejects.toMatchObject({
        code: 'SEQUENCE_SAVE_SETTLEMENT_FAILED',
        stateChanged: true,
        partialEffects: [expect.objectContaining({ documentId: f.id, path: f.path, saved: true })],
      });
      expect(f.model.getState().captureForSave(f.id)).toEqual(capture);
      expect(f.writes).toHaveBeenCalledOnce();
    } finally {
      await f.owner.close();
    }
  });
  it('settles a captured Save when a metadata refresh arrives during publication', async () => {
    const entered = deferred();
    const release = deferred();
    const f = await fixture(async () => {
      entered.resolve();
      await release.promise;
    });
    f.model.getState().setSequence(f.id, f.initial);
    await f.bridge.flush();
    await writeFile(
      f.path,
      serializeSequenceForInPlaceSave({ ...f.initial, circular: true }, f.path)
    );
    f.model.getState().patchSavedMetadata(f.id, { circular: true });
    await f.bridge.flush();
    expect(f.model.getState().sequences[f.id].circular).toBe(true);
    f.model.getState().replaceBases(f.id, 0, 1, 'T');
    await f.bridge.flush();
    const capture = f.model.getState().captureForSave(f.id);
    if (!capture) throw new Error('Missing Save capture');
    const save = f.bridge.save(f.id, { capture });
    const settled = Promise.allSettled([save]);
    try {
      await entered.promise;
      port.execute.mockClear();
      f.model.getState().patchSavedMetadata(f.id, { circular: true });
      await vi.waitFor(() =>
        expect(port.execute).toHaveBeenCalledWith(
          expect.objectContaining({ operation: { kind: 'refresh-metadata' } })
        )
      );
      release.resolve();
      await expect(save).resolves.toMatchObject({ saved: true, dirty: false });
      await expect(f.bridge.flush()).resolves.toBeUndefined();
      expect(f.model.getState().sequences[f.id]).toMatchObject({
        sequence: 'TAAACCCC',
        circular: true,
      });
      expect(
        parseSequenceFileAsDocument(await readFile(f.path, 'utf8'), f.path).sequence
      ).toMatchObject({ sequence: 'TAAACCCC', circular: true });
      expect(f.writes).toHaveBeenCalledOnce();
    } finally {
      release.resolve();
      await settled;
      await f.owner.close();
    }
  });

  it('keeps a later native cursor acknowledgement when the saved reply has the same revision', async () => {
    const f = await fixture();
    f.model.getState().setSequence(f.id, f.initial);
    await f.bridge.flush();
    f.model.getState().dispatchEdit(f.id, { type: 'INSERT', text: 'AT' });
    await f.bridge.flush();
    const entered = deferred();
    const release = deferred();
    port.execute.mockImplementation(async (request) => {
      const result = structuredClone(await f.owner.execute(request));
      if (request.operation.kind === 'publish-save') {
        entered.resolve();
        await release.promise;
      }
      return result;
    });
    const capture = f.model.getState().captureForSave(f.id);
    if (!capture) throw new Error('Missing Save capture');
    const save = f.bridge.save(f.id, { capture });
    try {
      await entered.promise;
      f.model.getState().dispatchEdit(f.id, { type: 'SET_CURSOR', position: 5 });
      await f.bridge.flush();
      release.resolve();
      const completed = await save;
      expect(completed).toMatchObject({ saved: true, dirty: false, version: capture.revision });
      expect(f.model.getState().drafts[f.id].cursor).toBe(5);
      expect(f.model.getState().isDirty(f.id)).toBe(false);
      expect(f.writes).toHaveBeenCalledOnce();
    } finally {
      release.resolve();
      await save;
      await f.owner.close();
    }
  });
  it('settles and continues an admitted Save without a new view-enrollment read after registered owner revocation', async () => {
    const registry = createRegisteredProjectAuthorityFixture();
    const workspaces = new NativeDocumentWorkspaces({ authority: registry.authority });
    const entered = deferred();
    const release = deferred();
    const f = await fixture(
      async () => {
        entered.resolve();
        await release.promise;
      },
      false,
      { captureWorkspace: (root) => workspaces.capture(root) }
    );
    registry.register(f.root);
    await workspaces.replaceRoots([f.root]);
    f.model.getState().setSequence(f.id, f.initial);
    await f.bridge.flush();
    f.model.getState().dispatchEdit(f.id, { type: 'INSERT', text: 'AT' });
    await f.bridge.flush();
    const capture = f.model.getState().captureForSave(f.id);
    if (!capture) throw new Error('Missing native Save capture');
    const save = f.bridge.save(f.id, { capture });
    const settled = save.then(
      (value) => ({ status: 'fulfilled' as const, value }),
      (reason: unknown) => ({ status: 'rejected' as const, reason })
    );
    try {
      await entered.promise;
      f.model.getState().dispatchEdit(f.id, { type: 'INSERT', text: 'G' });
      await f.bridge.flush();
      registry.remove(f.root);
      await workspaces.replaceRoots([]);
      release.resolve();
      const result = await settled;
      expect(result).toMatchObject({ status: 'fulfilled', value: { saved: true, dirty: true } });
      if (result.status !== 'fulfilled') throw result.reason;
      expect(result.value.captureId).toBeTruthy();
      const newer = f.model.getState().captureForSave(f.id);
      if (!newer) throw new Error('Missing newer native Save capture');
      const continued = await f.bridge.save(f.id, {
        capture: newer,
        fromCaptureId: result.value.captureId,
      });
      expect(continued).toMatchObject({ saved: true, dirty: false, version: newer.revision });
      expect(f.writes).toHaveBeenCalledTimes(2);
      expect(
        parseSequenceFileAsDocument(await readFile(f.path, 'utf8'), f.path).sequence.sequence
      ).toBe('ATGAAAACCCC');
      expect(f.model.getState().sequences[f.id].sequence).toBe('ATGAAAACCCC');
      expect(
        port.execute.mock.calls.filter(([request]) => request.operation.kind === 'inspect')
      ).toHaveLength(1);
    } finally {
      release.resolve();
      await settled;
      await f.owner.close();
    }
  });
  it.each(['clearSequence', 'clearAll'])(
    'keeps a cleared view unavailable after %s when its queued native edit is acknowledged',
    async (method) => {
      const f = await fixture();
      f.model.getState().setSequence(f.id, f.initial);
      await f.bridge.flush();
      f.model.getState().dispatchEdit(f.id, { type: 'INSERT', text: 'AT' });
      if (method === 'clearAll') f.model.getState().clearAll();
      else f.model.getState().clearSequence(f.id);
      expect(f.bridge.owns(f.id)).toBe(false);
      expect(f.model.getState().captureForSave(f.id)).toBeNull();
      await f.bridge.flush();
      expect(f.model.getState().captureForSave(f.id)).toBeNull();
      expect(f.model.getState().isDirty(f.id)).toBe(false);
      expect(f.model.getState().sequences[f.id]).toBeUndefined();
      expect(f.writes).not.toHaveBeenCalled();
      const retained = await f.owner.execute({
        documentId: f.id,
        operation: inspect,
        projection: 'document',
      });
      expect(retained.dirty).toBe(true);
      expect(retained.copy?.sequence.sequence).toBe(`AT${f.initial.sequence}`);
      port.available.mockResolvedValue(false);
      f.model.getState().setSequence(f.id, f.initial);
      await f.bridge.flush();
      expect(f.model.getState().sequences[f.id].sequence).toBe(f.initial.sequence);
      port.available.mockResolvedValue(true);
      f.bridge.refreshAvailableDocuments();
      await f.bridge.flush();
      expect(f.bridge.owns(f.id)).toBe(true);
      expect(f.model.getState().sequences[f.id].sequence).toBe(`AT${f.initial.sequence}`);
      expect(f.model.getState().isDirty(f.id)).toBe(true);
    }
  );
  it('saves an inserted baseline and the next cursor-directed deletion through the native owner', async () => {
    const f = await fixture();
    f.model.getState().setSequence(f.id, f.initial);
    await f.bridge.flush();
    f.model.getState().dispatchEdit(f.id, { type: 'SET_CURSOR', position: 0 });
    f.model.getState().dispatchEdit(f.id, { type: 'INSERT', text: 'C' });
    const inserted = f.model.getState().captureForSave(f.id);
    if (!inserted) throw new Error('Missing inserted native capture.');
    await f.bridge.save(f.id, { capture: inserted });
    expect(f.model.getState().sequences[f.id].sequence).toBe(`C${f.initial.sequence}`);
    expect(f.model.getState().isDirty(f.id)).toBe(false);
    f.model.getState().dispatchEdit(f.id, { type: 'SET_CURSOR', position: 0 });
    f.model.getState().dispatchEdit(f.id, { type: 'MOVE_CURSOR', delta: 1 });
    f.model.getState().dispatchEdit(f.id, { type: 'CLEAR_SELECTION_ANCHOR' });
    f.model.getState().dispatchEdit(f.id, { type: 'DELETE_BEFORE' });
    const deleted = f.model.getState().captureForSave(f.id);
    if (!deleted) throw new Error('Missing deletion native capture.');
    await f.bridge.save(f.id, { capture: deleted });
    expect(f.model.getState().sequences[f.id].sequence).toBe(f.initial.sequence);
    expect(f.model.getState().savedSequences[f.id].sequence).toBe(f.initial.sequence);
    expect(f.model.getState().isDirty(f.id)).toBe(false);
    expect(
      parseSequenceFileAsDocument(await readFile(f.path, 'utf8'), f.path).sequence.sequence
    ).toBe(f.initial.sequence);
  });

  it('refuses to downgrade an accepted native metadata copy to a local-file revision', async () => {
    const source = { readOnly: true, accepted: true };
    const f = await fixture(undefined, false, source);
    const initial = await f.owner.execute({
      documentId: f.id,
      operation: inspect,
      projection: 'document',
    });
    const bytes = await readFile(f.path);
    source.accepted = false;
    await expect(
      f.owner.execute({
        documentId: f.id,
        expectedVersion: initial.version,
        operation: { kind: 'refresh-metadata' },
        projection: 'document',
      })
    ).rejects.toThrow('FILE_CHANGED');
    const retained = await f.owner.execute({
      documentId: f.id,
      operation: inspect,
      projection: 'document',
    });
    expect(retained.copy?.acceptedRevision).toEqual(initial.copy?.acceptedRevision);
    expect(await readFile(f.path)).toEqual(bytes);
    expect(f.writes).not.toHaveBeenCalled();
  });

  it.each([false, true])(
    'reads accepted saved metadata on a read-only native sequence without authorizing writes with accepted=%s',
    async (accepted) => {
      const f = await fixture(undefined, false, { readOnly: true, accepted });
      const bytes = await readFile(f.path);
      const initial = await f.owner.execute({
        documentId: f.id,
        operation: inspect,
        projection: 'document',
      });
      const refreshed = await f.owner.execute({
        documentId: f.id,
        expectedVersion: initial.version,
        operation: { kind: 'refresh-metadata' },
        projection: 'document',
      });
      expect(refreshed.readOnly).toBe(true);
      expect(refreshed.copy?.sequence.name).toBe('Client');
      expect(refreshed.dirty).toBe(false);
      for (const operation of [
        {
          kind: 'client-command' as const,
          command: { method: 'patchSavedMetadata' as const, patch: { name: 'FORGED' } },
        },
        {
          kind: 'client-command' as const,
          command: { method: 'replaceBases' as const, start: 0, end: 1, bases: 'T' },
        },
        { kind: 'save' as const, message: 'Save read-only sequence' },
      ])
        await expect(
          f.owner.execute({
            documentId: f.id,
            expectedVersion: refreshed.version,
            operation,
            projection: 'document',
          })
        ).rejects.toThrow('READ_ONLY_SEQUENCE');
      expect(await readFile(f.path)).toEqual(bytes);
      expect(f.writes).not.toHaveBeenCalled();
    }
  );

  it.each([false, true])(
    'reflects accepted saved metadata through a native read on read-only archived sequences with accepted=%s',
    async (accepted) => {
      const f = await fixture(undefined, false, { readOnly: true, accepted });
      f.model.getState().setSequence(f.id, f.initial);
      await f.bridge.flush();
      const bytes = await readFile(f.path);
      port.execute.mockClear();
      const log = vi.spyOn(console, 'error').mockImplementation(() => {});
      try {
        f.model.getState().patchSavedMetadata(f.id, { name: 'renderer-supplied' });
        await f.bridge.flush();
        expect(port.execute).toHaveBeenLastCalledWith(
          expect.objectContaining({ operation: { kind: 'refresh-metadata' } })
        );
        expect(f.model.getState().sequences[f.id].name).toBe('Client');
        expect(f.model.getState().savedSequences[f.id].name).toBe('Client');
        expect(log).not.toHaveBeenCalled();
        expect(() => f.model.getState().replaceBases(f.id, 0, 1, 'T')).toThrow(
          'READ_ONLY_SEQUENCE'
        );
        expect(await readFile(f.path)).toEqual(bytes);
        expect(f.writes).not.toHaveBeenCalled();
      } finally {
        log.mockRestore();
      }
    }
  );

  it.each([false, true])(
    'refuses metadata refresh when saved biological content changed on a read-only sequence with accepted=%s',
    async (accepted) => {
      const f = await fixture(undefined, false, { readOnly: true, accepted });
      const initial = await f.owner.execute({
        documentId: f.id,
        operation: inspect,
        projection: 'document',
      });
      const changed = serializeSequenceForInPlaceSave(
        { ...f.initial, sequence: 'TTTTGGGG' },
        f.path
      );
      await writeFile(f.path, changed);
      await expect(
        f.owner.execute({
          documentId: f.id,
          expectedVersion: initial.version,
          operation: { kind: 'refresh-metadata' },
          projection: 'document',
        })
      ).rejects.toThrow('FILE_CHANGED');
      const retained = await f.owner.execute({
        documentId: f.id,
        operation: inspect,
        projection: 'document',
      });
      expect(retained.copy?.sequence.sequence).toBe('AAAACCCC');
      expect(await readFile(f.path, 'utf8')).toBe(changed);
      expect(f.writes).not.toHaveBeenCalled();
    }
  );

  it.each([false, true])(
    'keeps view-only selection local outside native scope with prior snapshot=%s',
    async (loaded) => {
      const f = await fixture();
      port.available.mockResolvedValue(loaded);
      f.model.getState().setSequence(f.id, f.initial);
      await f.bridge.flush();
      port.execute.mockClear();
      port.available.mockResolvedValue(false);
      f.model.getState().dispatchEdit(f.id, { type: 'SET_CURSOR', position: 3 });
      await f.bridge.flush();
      expect(port.execute).not.toHaveBeenCalled();
      expect(f.model.getState().drafts[f.id].cursor).toBe(3);
      expect(f.model.getState().sequences[f.id].sequence).toBe('AAAACCCC');
      expect(f.writes).not.toHaveBeenCalled();
    }
  );

  it.each([
    { loaded: false, method: 'patchSavedMetadata' },
    { loaded: true, method: 'patchSavedMetadata' },
    { loaded: false, method: 'acknowledgeMetadata' },
    { loaded: true, method: 'acknowledgeMetadata' },
  ] as const)(
    'defers $method synchronization outside native scope with prior snapshot=$loaded',
    async ({ loaded, method }) => {
      const f = await fixture();
      port.available.mockResolvedValue(loaded);
      f.model.getState().setSequence(f.id, f.initial);
      await f.bridge.flush();
      const bytes = await readFile(f.path);
      const saved = f.model.getState().savedSequences[f.id];
      const execute = port.execute.getMockImplementation()!;
      port.execute.mockClear();
      port.available.mockResolvedValue(false);
      port.execute.mockRejectedValue(new Error('SEQUENCE_DOCUMENT_REFUSED: Project not enrolled.'));
      const log = vi.spyOn(console, 'error').mockImplementation(() => {});
      try {
        if (method === 'patchSavedMetadata')
          f.model.getState().patchSavedMetadata(f.id, { name: saved.name });
        else f.model.getState().acknowledgeMetadata(f.id, saved, { ...saved });
        await f.bridge.flush();
        expect(port.execute).not.toHaveBeenCalled();
        expect(f.model.getState().sequences[f.id]).toEqual(saved);
        expect(f.model.getState().savedSequences[f.id]).toEqual(saved);
        expect(log).not.toHaveBeenCalled();
        expect(await readFile(f.path)).toEqual(bytes);
        expect(f.writes).not.toHaveBeenCalled();
        port.available.mockResolvedValue(true);
        port.execute.mockImplementation(execute);
        f.bridge.refreshAvailableDocuments();
        await f.bridge.flush();
        expect(port.execute).toHaveBeenCalled();
        const accepted = await f.owner.execute({
          documentId: f.id,
          operation: inspect,
          projection: 'document',
        });
        expect(f.model.getState().sequences[f.id]).toEqual(accepted.copy?.sequence);
        expect(f.model.getState().savedSequences[f.id]).toEqual(accepted.copy?.savedSequence);
        expect(log).not.toHaveBeenCalled();
        expect(await readFile(f.path)).toEqual(bytes);
        expect(f.writes).not.toHaveBeenCalled();
      } finally {
        log.mockRestore();
      }
    }
  );

  it('allows explicit discard to drain a rejected edit while saving still refuses it', async () => {
    const f = await fixture();
    f.model.getState().setSequence(f.id, f.initial);
    await f.bridge.flush();
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      port.execute.mockRejectedValue(new Error('The document workspace is not enrolled.'));
      f.model.getState().replaceBases(f.id, 0, 1, 'T');
      await expect(f.bridge.flush()).rejects.toThrow('not enrolled');
      await expect(f.bridge.flush('discard')).resolves.toBeUndefined();
      await expect(f.bridge.flush()).rejects.toThrow('not enrolled');
      expect(f.writes).not.toHaveBeenCalled();
    } finally {
      log.mockRestore();
    }
  });

  it('does not finish discard draining while a sequence command is still in flight', async () => {
    const f = await fixture();
    f.model.getState().setSequence(f.id, f.initial);
    await f.bridge.flush();
    const pending = deferred();
    const execute = port.execute.getMockImplementation()!;
    port.execute.mockImplementation(async (...args) => {
      await pending.promise;
      return execute(...args);
    });
    f.model.getState().replaceBases(f.id, 0, 1, 'T');
    let drained = false;
    const draining = f.bridge.flush('discard').then(() => {
      drained = true;
    });
    await Promise.resolve();
    await Promise.resolve();
    expect(drained).toBe(false);
    pending.resolve();
    await draining;
    expect(drained).toBe(true);
    expect(f.writes).not.toHaveBeenCalled();
  });

  it('still refuses biological input through the native owner when a cached document is unavailable', async () => {
    const f = await fixture();
    f.model.getState().setSequence(f.id, f.initial);
    await f.bridge.flush();
    port.available.mockResolvedValue(false);
    const bytes = await readFile(f.path);
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      port.execute.mockRejectedValue(new Error('READ_ONLY_SEQUENCE: The project is unavailable.'));
      f.model.getState().replaceBases(f.id, 0, 1, 'T');
      await expect(f.bridge.flush()).rejects.toThrow('READ_ONLY_SEQUENCE');
      expect(port.execute).toHaveBeenCalled();
      expect(log).toHaveBeenCalledWith(
        '[Native sequence document]',
        expect.any(Error),
        'command=replaceBases'
      );
      expect(await readFile(f.path)).toEqual(bytes);
      expect(f.writes).not.toHaveBeenCalled();
    } finally {
      log.mockRestore();
    }
  });

  it('freezes cached biological input until the current native copy is ready after remount', async () => {
    const f = await fixture();
    port.available.mockResolvedValue(false);
    f.model.getState().setSequence(f.id, f.initial);
    await f.bridge.flush();
    const changed = serializeSequenceForInPlaceSave({ ...f.initial, sequence: 'TTTTGGGG' }, f.path);
    await writeFile(f.path, changed);
    port.available.mockResolvedValue(true);
    let refused: unknown;
    try {
      f.model.getState().replaceBases(f.id, 0, 1, 'G');
    } catch (error) {
      refused = error;
    }
    await f.bridge.flush();
    expect(f.model.getState().sequences[f.id].sequence).toBe('AAAACCCC');
    expect(refused).toBeInstanceOf(Error);
    expect((refused as Error).message).toContain('SEQUENCE_DOCUMENT_NOT_READY');
    expect(port.execute).not.toHaveBeenCalled();
    f.bridge.refreshAvailableDocuments();
    await f.bridge.flush();
    expect(f.model.getState().sequences[f.id].sequence).toBe('TTTTGGGG');
    f.model.getState().replaceBases(f.id, 0, 1, 'G');
    await f.bridge.flush();
    expect(f.model.getState().sequences[f.id].sequence).toBe('GTTTGGGG');
    expect(await readFile(f.path, 'utf8')).toBe(changed);
    expect(f.writes).not.toHaveBeenCalled();
  });

  it('cancels an automatic read when its native scope closes after admission and reconnects later', async () => {
    const f = await fixture();
    const execute = port.execute.getMockImplementation()!;
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      port.execute.mockImplementationOnce(async () => {
        port.available.mockResolvedValue(false);
        throw new Error('The document workspace is not enrolled with this native owner.');
      });
      f.model.getState().setSequence(f.id, f.initial);
      await f.bridge.flush();
      expect(log).not.toHaveBeenCalled();
      expect(f.model.getState().sequences[f.id]).toEqual(f.initial);
      port.available.mockResolvedValue(true);
      port.execute.mockImplementation(execute);
      f.bridge.refreshAvailableDocuments();
      await f.bridge.flush();
      expect(f.bridge.owns(f.id)).toBe(true);
      expect(f.model.getState().isLoading(f.id)).toBe(false);
      expect(f.writes).not.toHaveBeenCalled();
    } finally {
      log.mockRestore();
    }
  });

  it('reconnects cached sequences only after their native scope becomes available', async () => {
    const f = await fixture();
    port.available.mockResolvedValue(false);
    f.model.getState().setSequence(f.id, f.initial);
    await f.bridge.flush();
    expect(port.execute).not.toHaveBeenCalled();
    expect(f.model.getState().sequences[f.id]).toEqual(f.initial);
    expect(f.model.getState().isLoading(f.id)).toBe(false);
    expect(f.writes).not.toHaveBeenCalled();
    port.available.mockResolvedValue(true);
    f.bridge.refreshAvailableDocuments();
    await f.bridge.flush();
    expect(port.execute).toHaveBeenCalledWith(
      expect.objectContaining({
        documentId: f.id,
        operation: expect.objectContaining({ kind: 'inspect' }),
      })
    );
    f.model.getState().replaceBases(f.id, 0, 1, 'T');
    await f.bridge.flush();
    expect(f.model.getState().sequences[f.id].sequence).toBe('TAAACCCC');
    expect(f.writes).not.toHaveBeenCalled();
  });

  it('reports an available native sequence failure instead of concealing it during reconnect', async () => {
    const f = await fixture();
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      port.execute.mockRejectedValue(new Error('The accepted sequence is invalid.'));
      f.model.getState().setSequence(f.id, f.initial);
      await expect(f.bridge.flush()).rejects.toThrow('The accepted sequence is invalid.');
      expect(log).toHaveBeenCalledWith('[Native sequence document]', expect.any(Error));
      expect(() => f.bridge.assertInput(f.id)).toThrow('The accepted sequence is invalid.');
      expect(f.writes).not.toHaveBeenCalled();
    } finally {
      log.mockRestore();
    }
  });

  it('keeps biological object identity through cursor-only IPC acknowledgements', async () => {
    const f = await fixture();
    f.model.getState().setSequence(f.id, f.initial);
    await f.bridge.flush();
    const sequence = f.model.getState().sequences[f.id];
    const savedSequence = f.model.getState().savedSequences[f.id];
    const version = f.model.getState().getVersion(f.id);
    f.model.getState().dispatchEdit(f.id, { type: 'SET_CURSOR', position: 3 });
    await f.bridge.flush();
    expect(f.model.getState().drafts[f.id].cursor).toBe(3);
    expect(f.model.getState().getVersion(f.id)).toBe(version);
    expect(f.model.getState().sequences[f.id]).toBe(sequence);
    expect(f.model.getState().savedSequences[f.id]).toBe(savedSequence);
  });
  it('freezes human biological input while the native first ID stamp is pending and applies the saved IDs', async () => {
    let release!: () => void, entered!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const f = await fixture(async () => {
      entered();
      await gate;
    }, true);
    f.model.getState().setSequence(f.id, f.initial);
    await f.bridge.flush();
    f.model.getState().addAnnotation(f.id, {
      name: 'New feature',
      type: 'misc_feature',
      start: 1,
      end: 4,
      direction: 1,
    });
    await f.bridge.flush();
    const capture = f.model.getState().captureForSave(f.id)!;
    const save = f.bridge.save(f.id, { capture });
    await started;
    try {
      expect(f.model.getState().isLoading(f.id)).toBe(true);
      expect(() => f.model.getState().replaceBases(f.id, 0, 1, 'T')).toThrow(
        'SEQUENCE_DOCUMENT_NOT_READY'
      );
    } finally {
      release();
    }
    await save;
    expect(f.model.getState().isLoading(f.id)).toBe(false);
    const publishedId = listManagedGenBankAnnotations(await readFile(f.path, 'utf8'))[0].id;
    expect(f.model.getState().sequences[f.id].annotations[0].qualifiers?.dnaforge_ann_id).toEqual([
      publishedId,
    ]);
    expect(
      f.model.getState().savedSequences[f.id].annotations[0].qualifiers?.dnaforge_ann_id
    ).toEqual([publishedId]);
    f.model.getState().replaceBases(f.id, 0, 1, 'T');
    await f.bridge.flush();
    expect(f.model.getState().sequences[f.id].sequence).toBe('TAAACCCC');
  });
  it('coalesces duplicate initial loads into the same native revision', async () => {
    const f = await fixture();
    f.model.getState().setSequence(f.id, f.initial);
    f.model.getState().setSequence(f.id, f.initial);
    await f.bridge.flush();
    expect(
      port.execute.mock.calls.filter(([request]) => request.operation.kind === 'inspect')
    ).toHaveLength(1);
    expect(f.model.getState().getVersion(f.id)).toBe(f.owner.model.getState().getVersion(f.id));
    expect(f.model.getState().draftLineages[f.id].id).toBe(
      f.owner.model.getState().draftLineages[f.id].id
    );
  });
  it('shares a duplicate-view save receipt while B reaches native recovery before A finishes', async () => {
    let release!: () => void, entered!: () => void;
    const gate = new Promise<void>((resolve) => {
        release = resolve;
      }),
      started = new Promise<void>((resolve) => {
        entered = resolve;
      });
    const f = await fixture(async () => {
      entered();
      await gate;
    });
    f.model.getState().setSequence(f.id, f.initial);
    await f.bridge.flush();
    f.model.getState().dispatchEdit(f.id, { type: 'SET_CURSOR', position: 0 });
    f.model.getState().dispatchEdit(f.id, { type: 'INSERT', text: 'TT' });
    await f.bridge.flush();
    const capture = f.model.getState().captureForSave(f.id)!;
    const first = f.bridge.save(f.id, { capture }),
      second = f.bridge.save(f.id, { capture });
    await started;
    f.model.getState().dispatchEdit(f.id, { type: 'INSERT', text: 'GG' });
    await f.bridge.flush();
    expect(f.records.get(f.id)?.copy.sequence.sequence).toBe('TTGGAAAACCCC');
    release();
    const receipts = await Promise.all([first, second]);
    expect(f.writes).toHaveBeenCalledTimes(1);
    expect(receipts.every((receipt) => receipt.saved && receipt.dirty)).toBe(true);
    expect(f.model.getState().sequences[f.id].sequence).toBe('TTGGAAAACCCC');
    expect(
      parseSequenceFileAsDocument(await readFile(f.path, 'utf8'), f.path).sequence.sequence
    ).toBe('TTAAAACCCC');
  });
});

describe('retained sequence input recovery at ordinary Save', () => {
  async function rejectedInput() {
    const authority = { missing: false, revoked: false };
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    const f = await fixture(undefined, false, {
      assertResolve: () => {
        if (authority.missing) throw new Error('The sequence has no unique owning project.');
      },
      captureWorkspace: () => () => {
        if (authority.revoked)
          throw new Error('READ_ONLY_SEQUENCE: Project write access was revoked.');
      },
      persistPendingPrimerBindings: async () => {},
    });
    f.model.getState().setSequence(f.id, f.initial);
    await f.bridge.flush();
    const original = await readFile(f.path, 'utf8');
    const acknowledgedVersion = f.owner.model.getState().getVersion(f.id);
    authority.missing = true;
    f.model.getState().dispatchEdit(f.id, { type: 'SET_CURSOR', position: 2 });
    f.model.getState().dispatchEdit(f.id, { type: 'INSERT', text: 'TT' });
    f.model.getState().dispatchEdit(f.id, { type: 'INSERT', text: 'AA' });
    const capture = structuredClone(f.model.getState().captureForSave(f.id)!);
    await expect(f.bridge.flush()).rejects.toThrow('no unique owning project');
    return {
      ...f,
      authority,
      capture,
      original,
      acknowledgedVersion,
      async close() {
        log.mockRestore();
        await f.owner.close();
      },
    };
  }

  it('recovers the exact frozen command sequence after the same native owner is restored', async () => {
    const f = await rejectedInput();
    try {
      await expect(f.bridge.save(f.id, { capture: f.capture })).rejects.toThrow(
        'no unique owning project'
      );
      expect(await readFile(f.path, 'utf8')).toBe(f.original);
      expect(f.model.getState().captureForSave(f.id)).toEqual(f.capture);
      expect(f.model.getState().isDirty(f.id)).toBe(true);
      expect(f.writes).not.toHaveBeenCalled();
      f.authority.missing = false;
      const saved = await f.bridge.save(f.id, { capture: f.capture });
      expect(saved.saved).toBe(true);
      expect(f.writes).toHaveBeenCalledTimes(1);
      expect(
        parseSequenceFileAsDocument(await readFile(f.path, 'utf8'), f.path).sequence.sequence
      ).toBe('AATTAAAACCCC');
      expect(f.model.getState().sequences[f.id].sequence).toBe(f.capture.sequence.sequence);
      expect(f.model.getState().isDirty(f.id)).toBe(false);
      expect(f.owner.model.getState().getVersion(f.id)).toBe(f.capture.revision);
      expect(f.captures).toHaveLength(1);
      expect(f.captures[0]).toMatchObject({
        draftLineageId: f.capture.draftLineageId,
        draftBaseline: f.capture.draftBaseline,
        sequence: f.capture.sequence,
      });
    } finally {
      await f.close();
    }
  });

  it('retains an acknowledged replay prefix and retries only the remaining biological input', async () => {
    const f = await rejectedInput();
    let replayed = 0;
    f.authority.missing = false;
    port.execute.mockImplementation(async (request) => {
      if (
        request.expectedRevision &&
        request.operation.kind === 'client-command' &&
        ++replayed === 3
      )
        throw new Error('The sequence has no unique owning project.');
      return structuredClone(await f.owner.execute(request));
    });
    try {
      await expect(f.bridge.save(f.id, { capture: f.capture })).rejects.toThrow(
        'no unique owning project'
      );
      expect(f.owner.model.getState().sequences[f.id].sequence).toBe('AATTAACCCC');
      expect(f.model.getState().captureForSave(f.id)).toEqual(f.capture);
      expect(await readFile(f.path, 'utf8')).toBe(f.original);
      expect(f.writes).not.toHaveBeenCalled();
      const saved = await f.bridge.save(f.id, { capture: f.capture });
      expect(saved.saved).toBe(true);
      expect(replayed).toBe(4);
      expect(f.writes).toHaveBeenCalledTimes(1);
      expect(
        parseSequenceFileAsDocument(await readFile(f.path, 'utf8'), f.path).sequence.sequence
      ).toBe(f.capture.sequence.sequence);
      expect(f.model.getState().isDirty(f.id)).toBe(false);
    } finally {
      await f.close();
    }
  });

  it.each(['source bytes', 'write authority', 'native biology', 'native cursor'] as const)(
    'retains the frozen renderer draft and refuses replay after changed %s',
    async (change) => {
      const f = await rejectedInput();
      f.authority.missing = false;
      let expectedBytes = f.original;
      if (change === 'source bytes') {
        expectedBytes = serializeSequenceForInPlaceSave(
          { ...f.initial, sequence: 'GGGGCCCC' },
          f.path
        );
        await writeFile(f.path, expectedBytes);
      }
      if (change === 'write authority') f.authority.revoked = true;
      if (change === 'native biology')
        await f.owner.execute({
          documentId: f.id,
          expectedVersion: f.owner.model.getState().getVersion(f.id),
          operation: { kind: 'replace-bases', start: 0, end: 1, bases: 'G', expectedBases: 'A' },
          projection: 'document',
        });
      if (change === 'native cursor')
        await f.owner.execute({
          documentId: f.id,
          expectedVersion: f.owner.model.getState().getVersion(f.id),
          operation: {
            kind: 'client-command',
            command: { method: 'dispatchEdit', action: { type: 'SET_CURSOR', position: 6 } },
          },
          projection: 'document',
        });
      const native = structuredClone(f.owner.model.getState().drafts[f.id]);
      try {
        await expect(f.bridge.save(f.id, { capture: f.capture })).rejects.toThrow(
          change === 'source bytes'
            ? 'FILE_CHANGED'
            : change === 'write authority'
              ? 'READ_ONLY_SEQUENCE'
              : 'STALE_SEQUENCE'
        );
        expect(f.model.getState().captureForSave(f.id)).toEqual(f.capture);
        expect(f.model.getState().isDirty(f.id)).toBe(true);
        expect(f.owner.model.getState().drafts[f.id]).toEqual(native);
        expect(await readFile(f.path, 'utf8')).toBe(expectedBytes);
        expect(f.writes).not.toHaveBeenCalled();
      } finally {
        await f.close();
      }
    }
  );

  it.each(['SET_CURSOR', 'INSERT'] as const)(
    'refuses to replay an ambiguously acknowledged %s command twice',
    async (lostAction) => {
      const f = await rejectedInput();
      f.authority.missing = false;
      let lost = false;
      port.execute.mockImplementation(async (request) => {
        const result = structuredClone(await f.owner.execute(request));
        if (
          !lost &&
          request.expectedRevision &&
          request.operation.kind === 'client-command' &&
          request.operation.command.method === 'dispatchEdit' &&
          request.operation.command.action.type === lostAction
        ) {
          lost = true;
          throw new Error('The native acknowledgement was lost.');
        }
        return result;
      });
      try {
        await expect(f.bridge.save(f.id, { capture: f.capture })).rejects.toThrow(
          'acknowledgement was lost'
        );
        const native = structuredClone(f.owner.model.getState().drafts[f.id]);
        await expect(f.bridge.save(f.id, { capture: f.capture })).rejects.toThrow('STALE_SEQUENCE');
        expect(f.owner.model.getState().drafts[f.id]).toEqual(native);
        expect(f.model.getState().captureForSave(f.id)).toEqual(f.capture);
        expect(await readFile(f.path, 'utf8')).toBe(f.original);
        expect(f.writes).not.toHaveBeenCalled();
      } finally {
        await f.close();
      }
    }
  );

  it('refuses an intervening native cursor change between the fresh inspect and first replay', async () => {
    const f = await rejectedInput();
    f.authority.missing = false;
    let intervened = false;
    port.execute.mockImplementation(async (request) => {
      if (!intervened && request.expectedRevision && request.operation.kind === 'client-command') {
        intervened = true;
        await f.owner.execute({
          documentId: f.id,
          expectedVersion: f.owner.model.getState().getVersion(f.id),
          operation: {
            kind: 'client-command',
            command: { method: 'dispatchEdit', action: { type: 'SET_CURSOR', position: 6 } },
          },
          projection: 'document',
        });
      }
      return structuredClone(await f.owner.execute(request));
    });
    try {
      await expect(f.bridge.save(f.id, { capture: f.capture })).rejects.toThrow('STALE_SEQUENCE');
      expect(intervened).toBe(true);
      expect(f.owner.model.getState().getVersion(f.id)).toBe(f.acknowledgedVersion);
      expect(f.owner.model.getState().drafts[f.id].cursor).toBe(6);
      expect(f.model.getState().captureForSave(f.id)).toEqual(f.capture);
      expect(await readFile(f.path, 'utf8')).toBe(f.original);
      expect(f.writes).not.toHaveBeenCalled();
    } finally {
      await f.close();
    }
  });

  it('discards failed public input after restoration without replaying it into a fresh save', async () => {
    const f = await rejectedInput();
    f.authority.missing = false;
    try {
      expect(f.bridge.isInputPending(f.id)).toBe(false);
      expect(() => f.bridge.assertInput(f.id)).toThrow('no unique owning project');
      expect(() => f.model.getState().discardEdits(f.id)).not.toThrow();
      await f.bridge.flush();
      expect(f.model.getState().sequences[f.id].sequence).toBe(f.initial.sequence);
      expect(f.model.getState().isDirty(f.id)).toBe(false);
      expect(await readFile(f.path, 'utf8')).toBe(f.original);
      expect(f.writes).not.toHaveBeenCalled();
      f.model.getState().dispatchEdit(f.id, { type: 'SET_CURSOR', position: 0 });
      f.model.getState().dispatchEdit(f.id, { type: 'INSERT', text: 'GG' });
      await f.bridge.flush();
      const capture = f.model.getState().captureForSave(f.id)!;
      await expect(f.bridge.save(f.id, { capture })).resolves.toMatchObject({ saved: true });
      expect(f.writes).toHaveBeenCalledTimes(1);
      expect(
        parseSequenceFileAsDocument(await readFile(f.path, 'utf8'), f.path).sequence.sequence
      ).toBe(`GG${f.initial.sequence}`);
      expect(f.model.getState().isDirty(f.id)).toBe(false);
    } finally {
      await f.close();
    }
  });

  it('keeps retained input through reconnect and reload, and clears it only on explicit discard', async () => {
    const f = await rejectedInput();
    f.authority.missing = false;
    try {
      f.bridge.command({ method: 'setSequence', args: [f.id, f.initial] });
      await expect(f.bridge.flush()).rejects.toThrow('no unique owning project');
      await expect(f.bridge.execute(f.id, { kind: 'reload' })).rejects.toThrow(
        'no unique owning project'
      );
      expect(f.model.getState().captureForSave(f.id)).toEqual(f.capture);
      const discarded = await f.bridge.execute(f.id, { kind: 'discard' });
      expect(discarded.dirty).toBe(false);
      await f.bridge.flush();
      expect(f.model.getState().sequences[f.id].sequence).toBe(f.initial.sequence);
      expect(await readFile(f.path, 'utf8')).toBe(f.original);
      expect(f.writes).not.toHaveBeenCalled();
    } finally {
      await f.close();
    }
  });

  it('recovers pasted annotation content when native schema parsing changes property order', async () => {
    let missing = false;
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    const f = await fixture(undefined, false, {
      assertResolve: () => {
        if (missing) throw new Error('The sequence has no unique owning project.');
      },
    });
    f.model.getState().setSequence(f.id, f.initial);
    await f.bridge.flush();
    missing = true;
    f.model.getState().dispatchEdit(f.id, {
      type: 'INSERT_FRAGMENT',
      fragment: {
        sequence: 'AT',
        annotations: [
          {
            qualifiers: { note: ['retained synthetic annotation'] },
            direction: 1,
            end: 2,
            start: 1,
            type: 'misc_feature',
            name: 'Ordered paste',
          },
        ],
        primerBindings: [],
      },
    });
    const capture = structuredClone(f.model.getState().captureForSave(f.id)!);
    await expect(f.bridge.flush()).rejects.toThrow('no unique owning project');
    missing = false;
    try {
      const saved = await f.bridge.save(f.id, { capture });
      expect(saved.saved).toBe(true);
      expect(f.captures).toHaveLength(1);
      expect(f.captures[0].sequence).toEqual(capture.sequence);
      expect(f.model.getState().sequences[f.id].annotations).toEqual(capture.sequence.annotations);
      expect(f.model.getState().isDirty(f.id)).toBe(false);
      expect(f.writes).toHaveBeenCalledOnce();
    } finally {
      log.mockRestore();
      await f.owner.close();
    }
  });

  it('preserves normalized copied-primer identities when a refused paste is replayed once', async () => {
    let missing = false;
    const persist = vi.fn(async (_capture: SequenceSaveCapture) => {});
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    const f = await fixture(undefined, false, {
      assertResolve: () => {
        if (missing) throw new Error('The sequence has no unique owning project.');
      },
      persistPendingPrimerBindings: persist,
    });
    f.model.getState().setSequence(f.id, f.initial);
    await f.bridge.flush();
    missing = true;
    f.model.getState().dispatchEdit(f.id, {
      type: 'INSERT_FRAGMENT',
      fragment: {
        sequence: 'AT',
        annotations: [],
        primerBindings: [{ primerId: 'copied-primer', start: 0, end: 2, strand: 1 }],
      },
    });
    const capture = structuredClone(f.model.getState().captureForSave(f.id)!);
    await expect(f.bridge.flush()).rejects.toThrow('no unique owning project');
    missing = false;
    try {
      const saved = await f.bridge.save(f.id, { capture });
      expect(saved.saved).toBe(true);
      expect(persist).toHaveBeenCalledTimes(1);
      expect(persist.mock.calls[0][0]).toMatchObject({
        pendingPrimerBindings: capture.pendingPrimerBindings,
        draftLineageId: capture.draftLineageId,
      });
      expect(f.writes).toHaveBeenCalledTimes(1);
      expect(
        parseSequenceFileAsDocument(await readFile(f.path, 'utf8'), f.path).sequence.sequence
      ).toBe(capture.sequence.sequence);
      expect(f.model.getState().isDirty(f.id)).toBe(false);
    } finally {
      log.mockRestore();
      await f.owner.close();
    }
  });
});

it('binds an ordinary initial Save to the acknowledged native revision and full copy without requiring retained input', async () => {
  const f = await fixture();
  f.model.getState().setSequence(f.id, f.initial);
  await f.bridge.flush();
  f.model.getState().replaceBases(f.id, 0, 1, 'T');
  await f.bridge.flush();
  const capture = structuredClone(f.model.getState().captureForSave(f.id)!);
  const acknowledged = await f.owner.execute({
    documentId: f.id,
    operation: inspect,
    projection: 'document',
  });
  port.execute.mockClear();
  try {
    const saved = await f.bridge.save(f.id, { capture });
    const requests = port.execute.mock.calls
      .map(([request]) => request)
      .filter((request) => request.operation.kind === 'capture-save');
    expect(requests).toHaveLength(1);
    expect(requests[0].expectedRevision).toEqual({
      revision: acknowledged.revision,
      copyJson: JSON.stringify(acknowledged.copy),
      bindingIdentity: acknowledged.bindingIdentity,
    });
    expect(saved.saved).toBe(true);
    expect(f.writes).toHaveBeenCalledTimes(1);
    expect(f.model.getState().isDirty(f.id)).toBe(false);
    expect(
      parseSequenceFileAsDocument(await readFile(f.path, 'utf8'), f.path).sequence.sequence
    ).toBe(capture.sequence.sequence);
  } finally {
    await f.owner.close();
  }
});

it('refuses an ordinary Save if an unrelated native cursor changes after capture at the same numeric revision', async () => {
  const f = await fixture();
  f.model.getState().setSequence(f.id, f.initial);
  await f.bridge.flush();
  f.model.getState().replaceBases(f.id, 0, 1, 'T');
  await f.bridge.flush();
  const capture = structuredClone(f.model.getState().captureForSave(f.id)!);
  const before = await readFile(f.path, 'utf8');
  let intervened = false;
  port.execute.mockImplementation(async (request) => {
    if (!intervened && request.operation.kind === 'capture-save') {
      intervened = true;
      await f.owner.execute({
        documentId: f.id,
        expectedVersion: capture.revision,
        operation: {
          kind: 'client-command',
          command: { method: 'dispatchEdit', action: { type: 'SET_CURSOR', position: 6 } },
        },
        projection: 'document',
      });
    }
    return structuredClone(await f.owner.execute(request));
  });
  try {
    await expect(f.bridge.save(f.id, { capture })).rejects.toThrow('STALE_SEQUENCE');
    expect(intervened).toBe(true);
    expect(f.owner.model.getState().getVersion(f.id)).toBe(capture.revision);
    expect(f.owner.model.getState().drafts[f.id].cursor).toBe(6);
    expect(f.model.getState().captureForSave(f.id)).toEqual(capture);
    expect(f.model.getState().isDirty(f.id)).toBe(true);
    expect(await readFile(f.path, 'utf8')).toBe(before);
    expect(f.writes).not.toHaveBeenCalled();
  } finally {
    await f.owner.close();
  }
});

it('keeps native and projected undo cleanliness aligned while revisions advance', async () => {
  const f = await fixture();
  try {
    f.model.getState().setSequence(f.id, f.initial);
    await f.bridge.flush();
    const originalBytes = await readFile(f.path);
    f.model.getState().dispatchEdit(f.id, { type: 'SET_CURSOR', position: 1 });
    await f.bridge.flush();
    expect(f.owner.model.getState().isDirty(f.id)).toBe(false);
    expect(f.model.getState().isDirty(f.id)).toBe(false);
    f.model.getState().dispatchEdit(f.id, { type: 'INSERT', text: 'A' });
    await f.bridge.flush();
    const edited = f.model.getState().sequences[f.id].sequence;
    expect(edited).toBe('AAAAACCCC');
    expect(f.owner.model.getState().isDirty(f.id)).toBe(true);
    expect(f.model.getState().isDirty(f.id)).toBe(true);
    f.model.getState().dispatchEdit(f.id, { type: 'UNDO' });
    await f.bridge.flush();
    expect(f.owner.model.getState().sequences[f.id].sequence).toBe(f.initial.sequence);
    expect(f.model.getState().sequences[f.id].sequence).toBe(f.initial.sequence);
    expect(f.owner.model.getState().isDirty(f.id)).toBe(false);
    expect(f.model.getState().sequenceVersions[f.id]).toBeGreaterThan(
      f.model.getState().savedVersions[f.id]
    );
    expect(f.model.getState().isDirty(f.id)).toBe(false);
    f.model.getState().dispatchEdit(f.id, { type: 'UNDO' });
    await f.bridge.flush();
    expect(f.model.getState().sequences[f.id].sequence).toBe(f.initial.sequence);
    expect(f.model.getState().isDirty(f.id)).toBe(false);
    f.model.getState().dispatchEdit(f.id, { type: 'REDO' });
    await f.bridge.flush();
    expect(f.owner.model.getState().sequences[f.id].sequence).toBe(edited);
    expect(f.model.getState().sequences[f.id].sequence).toBe(edited);
    expect(f.owner.model.getState().isDirty(f.id)).toBe(true);
    expect(f.model.getState().isDirty(f.id)).toBe(true);
    f.model.getState().dispatchEdit(f.id, { type: 'UNDO' });
    await f.bridge.flush();
    expect(f.model.getState().sequences[f.id].sequence).toBe(f.initial.sequence);
    expect(f.owner.model.getState().isDirty(f.id)).toBe(false);
    expect(f.model.getState().isDirty(f.id)).toBe(false);
    expect(f.writes).not.toHaveBeenCalled();
    expect(await readFile(f.path)).toEqual(originalBytes);
  } finally {
    await f.owner.close();
  }
});
