import { createRegisteredProjectAuthorityFixture } from './__tests__/registered-project-authority-fixture';
import { createTestDb } from './__tests__/test-db';
import {
  acquireWorkspaceSyncDatabaseFence,
  assertCommittedDatabaseReadAllowed,
} from './workspace-sync-database-fence';
// @vitest-environment node

import { createHash } from 'node:crypto';
import { mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  ensureManagedGenBankAnnotationIds,
  listManagedGenBankAnnotations,
  serializeSequenceForInPlaceSave,
} from '@waypoint/sequence-utils';
import {
  NativeSequenceWorkingCopyOwner,
  type NativeSequenceRecord,
  type NativeSequenceSaveScope,
  type NativeSequenceScope,
} from './native-sequence-working-copy';
import { parseSequenceFileAsDocument } from '../shared/parse-sequence-file';
import { writeTextFileAtomicInMain } from './text-file-atomic';
import { nativeSequenceDocumentAdapter } from './native-sequence-document-adapter';
import { NativeDocumentWorkspaces } from './native-document-workspaces';
import { setSequenceSaveVerificationForTest } from './sequence-save-verification-test-seam';
import type {
  SequenceDocumentRequest,
  SequenceDocumentSnapshot,
} from '../shared/sequence-document';
import type { SequenceDocumentSaveResult } from '../shared/sequence-edit-lineage';

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((path) => rm(path, { recursive: true, force: true }))
  );
});
const inspect = {
  kind: 'inspect' as const,
  start: 0,
  limit: 1000,
  annotationOffset: 0,
  annotationLimit: 50,
};
async function fixture(
  pause?: () => Promise<void>,
  managed = false,
  options: {
    source?: { name: string; content: string };
    captureWorkspace?: (root: string) => () => void;
    afterProduct?: () => Promise<void>;
    assertResourceCurrent?: () => void;
    completeSave?: () => Promise<NonNullable<SequenceDocumentSnapshot['history']>>;
    pendingSave?: Extract<SequenceDocumentSaveResult, { status: 'accepted-pending' }>;
  } = {}
) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'native-sequence-working-copy-')));
  directories.push(root);
  const path = join(root, options.source?.name ?? 'native.gb'),
    documentId = 'native-sequence-owner';
  await writeFile(
    path,
    options.source?.content ??
      serializeSequenceForInPlaceSave(
        {
          id: documentId,
          name: 'Native',
          sequence: 'AAAACCCCGGGG',
          length: 12,
          annotations: [],
          circular: false,
          metadata: {},
        },
        path
      )
  );
  const records = new Map<string, NativeSequenceRecord>();
  const digest = async () =>
    `sha256:${createHash('sha256')
      .update(await readFile(path))
      .digest('hex')}`;
  const storeRecord = vi.fn(async (record: NativeSequenceRecord) => {
    records.set(record.documentId, structuredClone(record));
  });
  const create = () =>
    new NativeSequenceWorkingCopyOwner({
      resolve: async () => {
        const scope: NativeSequenceScope = {
          documentId,
          path,
          workspaceRoot: root,
          readOnly: false,
          managed,
          assertCurrent: options.captureWorkspace?.(root) ?? (() => {}),
          captureForSave(): NativeSequenceSaveScope {
            this.assertCurrent();
            return { ...this, assertCurrent: options.assertResourceCurrent ?? (() => {}) };
          },
        };
        return scope;
      },
      load: async () => ({
        sequence: parseSequenceFileAsDocument(await readFile(path, 'utf8'), path).sequence,
        sha256: await digest(),
      }),
      readSha256: digest,
      completeSave: options.completeSave,
      save: async (input, scope, baselineSha256) => {
        scope.assertCurrent();
        if (pause) await pause();
        if (options.pendingSave) return { result: options.pendingSave };
        const serialized = serializeSequenceForInPlaceSave(input.capture.sequence, path);
        const content = managed
          ? ensureManagedGenBankAnnotationIds(
              serialized,
              () => 'da3cbb17-1234-4aad-824c-55728eca3507',
              await readFile(path, 'utf8')
            )
          : serialized;
        await writeTextFileAtomicInMain({ path, content, expectedContentHash: baselineSha256 });
        await options.afterProduct?.();
        scope.assertCurrent();
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
      loadRecord: async (id) => records.get(id),
      storeRecord,
    });
  const owner = create();
  const command = (
    snapshot: SequenceDocumentSnapshot,
    operation: SequenceDocumentRequest['operation']
  ) =>
    owner.execute({
      documentId,
      expectedVersion: snapshot.version,
      operation,
      projection: 'document',
    });
  return {
    owner,
    create,
    root,
    path,
    documentId,
    records,
    storeRecord,
    command,
    inspect: () => owner.execute({ documentId, operation: inspect, projection: 'document' }),
  };
}

describe('native sequence working copy without a view', () => {
  it('retains a loose edited document and tells headless callers when a destination is required', async () => {
    const f = await fixture(undefined, false, {
      source: { name: 'original.seq', content: 'AAAACCCCGGGG' },
    });
    const original = await f.inspect();
    const edit = await f.command(original, {
      kind: 'replace-bases',
      start: 0,
      end: 1,
      bases: 'T',
      expectedBases: 'A',
    });
    expect(await f.owner.listDirty()).toMatchObject([
      { documentId: f.documentId, saveDestinationRequired: true },
    ]);
    expect(edit).toMatchObject({ dirty: true, readOnly: false, saveDestinationRequired: true });
    await expect(f.command(edit, { kind: 'save', message: 'save' })).rejects.toMatchObject({
      code: 'SEQUENCE_SAVE_DESTINATION_REQUIRED',
      stateChanged: false,
    });
    expect(await readFile(f.path, 'utf8')).toBe('AAAACCCCGGGG');
    expect(f.records.get(f.documentId)?.copy.sequence.sequence).toBe('TAAACCCCGGGG');
  });

  it('reopens a newer clean revision after undo without resurrecting a dirty draft', async () => {
    const f = await fixture();
    const current = await f.inspect();
    const edited = await f.command(current, {
      kind: 'replace-bases',
      start: 0,
      end: 1,
      bases: 'T',
      expectedBases: 'A',
    });
    const undone = await f.command(edited, { kind: 'undo' });
    expect(undone).toMatchObject({ dirty: false });
    expect(undone.version).toBeGreaterThan(undone.savedVersion);
    expect(f.records.get(f.documentId)).toMatchObject({ dirty: false });
    const reopened = await f
      .create()
      .execute({ documentId: f.documentId, operation: inspect, projection: 'document' });
    expect(reopened).toMatchObject({
      dirty: false,
      version: undone.version,
      savedVersion: undone.savedVersion,
    });
  });
  it('keeps the last recoverable revision when an edit cannot be recorded', async () => {
    const f = await fixture();
    const initial = await f.inspect();
    const change = {
      kind: 'replace-bases',
      start: 0,
      end: 1,
      bases: 'T',
      expectedBases: 'A',
    } as const;
    f.storeRecord.mockRejectedValueOnce(new Error('recovery unavailable'));
    await expect(f.command(initial, change)).rejects.toThrow('recovery unavailable');
    expect(await f.inspect()).toMatchObject({
      revision: initial.revision,
      copy: initial.copy,
      dirty: false,
    });
    expect((await f.command(initial, change)).dirty).toBe(true);
  });

  it('does not extend a prior Save continuation to a revision accepted after its publication', async () => {
    const registry = createRegisteredProjectAuthorityFixture();
    const workspaces = new NativeDocumentWorkspaces({ authority: registry.authority });
    const product = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const f = await fixture(undefined, false, {
      captureWorkspace: (root) => workspaces.capture(root),
      afterProduct: async () => {
        product.resolve();
        await release.promise;
      },
    });
    registry.register(f.root);
    await workspaces.replaceRoots([f.root]);
    const initial = await f.inspect();
    const edited = await f.command(initial, {
      kind: 'client-command',
      command: { method: 'dispatchEdit', action: { type: 'INSERT', text: 'AT' } },
    });
    const captured = await f.command(edited, { kind: 'capture-save', message: 'Captured project' });
    if (!captured.captureId) throw new Error('Missing native Save capture');
    try {
      await product.promise;
      await f.command(captured, {
        kind: 'client-command',
        command: { method: 'dispatchEdit', action: { type: 'INSERT', text: 'G' } },
      });
      release.resolve();
      const published = await f.command(captured, {
        kind: 'publish-save',
        captureId: captured.captureId,
      });
      const later = await f.command(published, {
        kind: 'client-command',
        command: { method: 'dispatchEdit', action: { type: 'INSERT', text: 'C' } },
      });
      registry.remove(f.root);
      await workspaces.replaceRoots([]);
      for (const snapshot of [published, later])
        await expect(
          f.command(snapshot, {
            kind: 'capture-save',
            message: 'Unaccepted continuation revision',
            fromCaptureId: captured.captureId,
          })
        ).rejects.toThrow('STALE_SEQUENCE_SAVE_CONTINUATION');
      expect(
        parseSequenceFileAsDocument(await readFile(f.path, 'utf8'), f.path).sequence.sequence
      ).toBe('ATAAAACCCCGGGG');
      expect(f.owner.model.getState().sequences[f.documentId].sequence).toBe('ATGCAAAACCCCGGGG');
    } finally {
      release.resolve();
      await f.owner.close();
    }
  });
  it('continues only the native revision accepted by a previous captured Save after registered project revocation', async () => {
    const registry = createRegisteredProjectAuthorityFixture();
    const workspaces = new NativeDocumentWorkspaces({ authority: registry.authority });
    const product = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    let historyCalls = 0;
    const f = await fixture(undefined, false, {
      captureWorkspace: (root) => workspaces.capture(root),
      afterProduct: async () => {
        product.resolve();
        await release.promise;
      },
      completeSave: async () => {
        historyCalls++;
        return { status: 'committed' };
      },
    });
    registry.register(f.root);
    await workspaces.replaceRoots([f.root]);
    const initial = await f.inspect();
    const edited = await f.command(initial, {
      kind: 'client-command',
      command: { method: 'dispatchEdit', action: { type: 'INSERT', text: 'AT' } },
    });
    const captured = await f.command(edited, { kind: 'capture-save', message: 'Captured project' });
    if (!captured.captureId) throw new Error('Missing native Save capture');
    try {
      await product.promise;
      const newer = await f.command(captured, {
        kind: 'client-command',
        command: { method: 'dispatchEdit', action: { type: 'INSERT', text: 'G' } },
      });
      registry.remove(f.root);
      await workspaces.replaceRoots([]);
      release.resolve();
      const published = await f.command(captured, {
        kind: 'publish-save',
        captureId: captured.captureId,
      });
      expect(published).toMatchObject({ saved: true, dirty: true, version: newer.version });
      expect(published.history).toBeUndefined();
      expect(historyCalls).toBe(0);
      await expect(
        f.command(published, {
          kind: 'capture-save',
          message: 'Foreign capture',
          fromCaptureId: '0321f68b-f6cf-4ebe-8816-5357db43e370',
        })
      ).rejects.toThrow('STALE_SEQUENCE_SAVE_CAPTURE');
      await expect(
        f.command(captured, {
          kind: 'capture-save',
          message: 'Stale revision',
          fromCaptureId: captured.captureId,
        })
      ).rejects.toThrow('STALE_SEQUENCE_SAVE_CONTINUATION');
      await expect(
        f.command(published, { kind: 'capture-save', message: 'New unscoped Save' })
      ).rejects.toThrow('registered project');
      const operation = {
        kind: 'capture-save' as const,
        message: 'Continue accepted revision',
        fromCaptureId: captured.captureId,
      };
      const continuation = await f.command(published, operation);
      expect(await f.command(published, operation)).toEqual(continuation);
      await expect(
        f.command(published, { ...operation, message: 'Changed continuation' })
      ).rejects.toThrow('SEQUENCE_SAVE_CONTINUATION_CHANGED');
      if (!continuation.captureId) throw new Error('Missing continuation Save capture');
      const completed = await f.command(continuation, {
        kind: 'publish-save',
        captureId: continuation.captureId,
      });
      expect(completed).toMatchObject({
        saved: true,
        dirty: false,
        version: newer.version,
        savedVersion: newer.version,
        history: { status: 'committed' },
      });
      expect(historyCalls).toBe(1);
      expect(
        parseSequenceFileAsDocument(await readFile(f.path, 'utf8'), f.path).sequence.sequence
      ).toBe('ATGAAAACCCCGGGG');
      await expect(
        f.command(completed, { ...operation, fromCaptureId: continuation.captureId })
      ).rejects.toThrow('STALE_SEQUENCE_SAVE_CONTINUATION');
    } finally {
      release.resolve();
      await f.owner.close();
    }
  });
  it('reports a written but unverified captured Save without acknowledging its draft', async () => {
    let historyCalls = 0;
    const f = await fixture(undefined, false, {
      completeSave: async () => {
        historyCalls++;
        return { status: 'committed' };
      },
    });
    const initial = await f.inspect();
    const edited = await f.command(initial, {
      kind: 'client-command',
      command: { method: 'dispatchEdit', action: { type: 'INSERT', text: 'AT' } },
    });
    const captured = await f.command(edited, { kind: 'capture-save', message: 'Unverified' });
    if (!captured.captureId) throw new Error('Missing native Save capture');
    setSequenceSaveVerificationForTest(() => {
      throw new Error('PRIVATE_VERIFICATION_CAUSE');
    });
    try {
      const published = await f.command(captured, {
        kind: 'publish-save',
        captureId: captured.captureId,
      });
      expect(published).toMatchObject({ saved: true, dirty: true, verificationFailed: true });
      expect(published.saveResult).toMatchObject({ status: 'saved' });
      expect(published.captureId).toBeUndefined();
      expect(JSON.stringify(published)).not.toContain('PRIVATE_VERIFICATION_CAUSE');
      expect(historyCalls).toBe(0);
      expect(
        parseSequenceFileAsDocument(await readFile(f.path, 'utf8'), f.path).sequence.sequence
      ).toBe('ATAAAACCCCGGGG');
    } finally {
      setSequenceSaveVerificationForTest(undefined);
      await f.owner.close();
    }
  });

  it('records a direct native Save capture even when newer accepted edits remain dirty', async () => {
    const product = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    let historyCalls = 0;
    const f = await fixture(undefined, false, {
      afterProduct: async () => {
        product.resolve();
        await release.promise;
      },
      completeSave: async () => {
        historyCalls++;
        return { status: 'committed' };
      },
    });
    const initial = await f.inspect();
    const edited = await f.command(initial, {
      kind: 'client-command',
      command: { method: 'dispatchEdit', action: { type: 'INSERT', text: 'AT' } },
    });
    const save = f.command(edited, { kind: 'save', message: 'Direct native capture' });
    try {
      await product.promise;
      const newer = await f.command(edited, {
        kind: 'client-command',
        command: { method: 'dispatchEdit', action: { type: 'INSERT', text: 'G' } },
      });
      release.resolve();
      expect(await save).toMatchObject({
        saved: true,
        dirty: true,
        version: newer.version,
        savedVersion: edited.version,
        history: { status: 'committed' },
      });
      expect(historyCalls).toBe(1);
      expect(
        parseSequenceFileAsDocument(await readFile(f.path, 'utf8'), f.path).sequence.sequence
      ).toBe('ATAAAACCCCGGGG');
    } finally {
      release.resolve();
      await save;
      await f.owner.close();
    }
  });

  it('reports accepted pending delivery to the captured Save and retains the direct command error', async () => {
    const pendingSave = {
      status: 'accepted-pending',
      reason: 'External metadata changed',
      lineage: 'recorded',
      eventId: 'event',
      accepted: {
        kind: 'accepted-object',
        operationId: 'operation',
        workspaceVersionId: 'version',
        resourceRevisionId: 'revision',
        resourceId: 'native-sequence-owner',
        contentSha256: 'a'.repeat(64),
        sequenceEditParentEventId: 'event',
      },
    } as const;
    const f = await fixture(undefined, false, { pendingSave });
    try {
      const initial = await f.inspect();
      const bytes = await readFile(f.path, 'utf8');
      const edited = await f.command(initial, {
        kind: 'client-command',
        command: { method: 'dispatchEdit', action: { type: 'INSERT', text: 'AT' } },
      });
      const capture = await f.command(edited, { kind: 'capture-save', message: 'Save sequence' });
      const outcome = await f.command(capture, {
        kind: 'publish-save',
        captureId: capture.captureId!,
      });
      expect(outcome).toMatchObject({
        saved: false,
        dirty: true,
        saving: false,
        savedVersion: initial.savedVersion,
        saveResult: pendingSave,
      });
      await expect(
        f.command(edited, { kind: 'save', message: 'Save sequence' })
      ).rejects.toMatchObject({
        code: 'SEQUENCE_PUBLICATION_PENDING',
        stateChanged: true,
        partialEffects: [expect.objectContaining(pendingSave)],
      });
      expect(await readFile(f.path, 'utf8')).toBe(bytes);
    } finally {
      await f.owner.close();
    }
  });
  it('returns the admitted Save result when its authority read overlaps a database fence', async () => {
    const db = createTestDb();
    const written = Promise.withResolvers<void>();
    const resume = Promise.withResolvers<void>();
    let readWasBlocked = false;
    const afterProduct = vi.fn(async () => {
      written.resolve();
      await resume.promise;
    });
    const f = await fixture(undefined, false, {
      afterProduct,
      assertResourceCurrent() {
        try {
          assertCommittedDatabaseReadAllowed(db);
        } catch (error) {
          readWasBlocked = true;
          throw error;
        }
      },
    });
    try {
      const edited = await f.command(await f.inspect(), {
        kind: 'replace-bases',
        start: 0,
        end: 1,
        bases: 'T',
        expectedBases: 'A',
      });
      const captured = await f.command(edited, { kind: 'capture-save', message: 'Save document' });
      await written.promise;
      const release = await acquireWorkspaceSyncDatabaseFence(db);
      const result = Promise.allSettled([
        f.command(captured, { kind: 'publish-save', captureId: captured.captureId! }),
      ]);
      try {
        await vi.waitFor(() => expect(readWasBlocked).toBe(true));
      } finally {
        release();
        resume.resolve();
      }
      expect(await result).toMatchObject([
        { status: 'fulfilled', value: { saved: true, dirty: false } },
      ]);
      expect(afterProduct).toHaveBeenCalledOnce();
    } finally {
      resume.resolve();
      await f.owner.close();
      db.close();
    }
  });
  it('refuses a captured Save if its resource authority changes after admission', async () => {
    const product = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    let current = true;
    const f = await fixture(undefined, false, {
      afterProduct: async () => {
        product.resolve();
        await release.promise;
      },
      assertResourceCurrent() {
        if (!current) throw new Error('Captured resource authority changed');
      },
    });
    const initial = await f.inspect();
    const edited = await f.command(initial, {
      kind: 'client-command',
      command: { method: 'dispatchEdit', action: { type: 'INSERT', text: 'AT' } },
    });
    const captured = await f.command(edited, { kind: 'capture-save', message: 'Captured project' });
    if (!captured.captureId) throw new Error('Missing native Save capture');
    await product.promise;
    current = false;
    release.resolve();
    await expect(
      f.command(captured, { kind: 'publish-save', captureId: captured.captureId })
    ).rejects.toThrow('Captured resource authority changed');
    expect(f.owner.model.getState().isDirty(f.documentId)).toBe(true);
    await f.owner.close();
  });
  it('finishes an admitted captured Save after project replacement while refusing new unauthorized input', async () => {
    const registry = createRegisteredProjectAuthorityFixture();
    const workspaces = new NativeDocumentWorkspaces({ authority: registry.authority });
    const product = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const f = await fixture(undefined, false, {
      captureWorkspace: (root) => workspaces.capture(root),
      afterProduct: async () => {
        product.resolve();
        await release.promise;
      },
    });
    const otherRoot = await realpath(await mkdtemp(join(tmpdir(), 'native-sequence-other-')));
    directories.push(otherRoot);
    const otherPath = join(otherRoot, 'other.txt');
    await writeFile(otherPath, 'other project remains unchanged');
    registry.register(f.root);
    registry.register(otherRoot);
    await workspaces.replaceRoots([f.root, otherRoot]);
    const originalPermit = workspaces.capture(f.root);
    const initial = await f.inspect();
    const edited = await f.command(initial, {
      kind: 'client-command',
      command: { method: 'dispatchEdit', action: { type: 'INSERT', text: 'AT' } },
    });
    const captured = await f.command(edited, { kind: 'capture-save', message: 'Captured project' });
    if (!captured.captureId) throw new Error('Missing native Save capture');
    const publication = f.command(captured, {
      kind: 'publish-save',
      captureId: captured.captureId,
    });
    const completed = publication.then(
      (value) => ({ status: 'fulfilled' as const, value }),
      (reason: unknown) => ({ status: 'rejected' as const, reason })
    );
    try {
      await product.promise;
      const newer = await f.command(captured, {
        kind: 'client-command',
        command: { method: 'dispatchEdit', action: { type: 'INSERT', text: 'G' } },
      });
      registry.remove(f.root);
      await workspaces.replaceRoots([otherRoot]);
      expect(() => originalPermit()).toThrow('registered project authority changed');
      await expect(
        f.command(newer, {
          kind: 'client-command',
          command: { method: 'dispatchEdit', action: { type: 'INSERT', text: 'T' } },
        })
      ).rejects.toThrow('registered project');
      await expect(
        f.command(newer, { kind: 'capture-save', message: 'Unenrolled new Save' })
      ).rejects.toThrow('registered project');
      release.resolve();
      expect(await completed).toMatchObject({
        status: 'fulfilled',
        value: {
          saved: true,
          dirty: true,
          version: newer.version,
          savedVersion: captured.version,
        },
      });
      expect(
        parseSequenceFileAsDocument(await readFile(f.path, 'utf8'), f.path).sequence.sequence
      ).toBe('ATAAAACCCCGGGG');
      expect(f.owner.model.getState().sequences[f.documentId].sequence).toBe('ATGAAAACCCCGGGG');
      expect(await readFile(otherPath, 'utf8')).toBe('other project remains unchanged');
    } finally {
      release.resolve();
      await completed;
      await f.owner.close();
    }
  });

  it('opens, edits and saves a sequence through the general document boundary', async () => {
    const f = await fixture(),
      adapter = nativeSequenceDocumentAdapter(f.owner),
      observed: string[] = [];
    const detach = adapter.subscribe((snapshot) => {
      observed.push(snapshot.lifecycle?.save.availability ?? 'missing');
    });
    try {
      const initial = await adapter.execute({
        target: { documentId: f.documentId },
        operation: {
          kind: 'inspect',
          offset: 0,
          limit: 1000,
          rowOffset: 0,
          rowLimit: 20,
          columnOffset: 0,
          columnLimit: 20,
        },
      });
      expect(initial.lifecycle?.edit.availability).toBe('native');
      expect(initial.lifecycle?.edit.commands).toContain('replace-bases');
      expect(initial.lifecycle?.history.commands).toEqual(['undo', 'redo']);
      expect(initial.lifecycle?.save.commands).toEqual(['save']);
      const changed = await adapter.execute({
        target: { documentId: f.documentId },
        expectedRevision: initial.revision,
        operation: {
          kind: 'sequence',
          command: {
            kind: 'replace-bases',
            start: 0,
            end: 4,
            bases: 'TTTT',
            expectedBases: 'AAAA',
          },
        },
      });
      expect(changed.dirty).toBe(true);
      const saved = await adapter.execute({
        target: { documentId: f.documentId },
        expectedRevision: changed.revision,
        operation: { kind: 'save' },
      });
      expect(saved.dirty).toBe(false);
      expect(
        parseSequenceFileAsDocument(await readFile(f.path, 'utf8'), f.path).sequence.sequence
      ).toBe('TTTTCCCCGGGG');
      expect(observed).toContain('native');
    } finally {
      detach();
      await f.owner.close();
    }
  });

  it('keeps large biological annotations available to the UI while bounding public inspection and mutation receipts', async () => {
    const f = await fixture();
    const before = await f.inspect();
    const text = 'A'.repeat(6000);
    const result = await f.owner.execute({
      documentId: f.documentId,
      expectedVersion: before.version,
      operation: {
        kind: 'add-annotation',
        annotation: {
          name: 'Large feature',
          type: 'misc_feature',
          color: '#888888',
          start: 1,
          end: 4,
          direction: 1,
          qualifiers: {
            note: Array<string>(100).fill(text),
            evidence: Array<string>(100).fill(text),
          },
        },
      },
    });
    expect(result).toMatchObject({
      annotationCount: 1,
      annotations: [],
      nextAnnotationOffset: 0,
      dirty: true,
    });
    const full = await f.inspect();
    expect(full.copy?.sequence.annotations[0].qualifiers?.note).toHaveLength(100);
    expect(full.copy?.sequence.annotations[0].qualifiers?.note?.[0]).toBe(text);
    await expect(
      f.owner.execute({ documentId: f.documentId, operation: inspect })
    ).rejects.toMatchObject({ code: 'INSPECTION_TOO_LARGE', stateChanged: false });
    const metadata = await f.owner.execute({
      documentId: f.documentId,
      operation: { ...inspect, annotationLimit: 0 },
    });
    expect(metadata).toMatchObject({
      version: result.version,
      annotationCount: 1,
      annotations: [],
      nextAnnotationOffset: 0,
    });
  });
  it('protects a clean native copy during annotation Apply and refreshes the shared owner before release', async () => {
    const f = await fixture();
    const before = await f.inspect();
    const protection = await f.owner.protectCleanDocument(f.documentId, f.path);
    protection.assertCurrent();
    await expect(
      f.command(before, {
        kind: 'replace-bases',
        start: 0,
        end: 4,
        bases: 'TTTT',
        expectedBases: 'AAAA',
      })
    ).rejects.toMatchObject({ code: 'SEQUENCE_DOCUMENT_BUSY', stateChanged: false });
    const published = parseSequenceFileAsDocument(await readFile(f.path, 'utf8'), f.path).sequence;
    published.annotations = [
      { name: 'Applied feature', type: 'misc_feature', start: 1, end: 4, direction: 1 },
    ];
    await writeFile(f.path, serializeSequenceForInPlaceSave(published, f.path));
    await protection.finish();
    const after = await f.inspect();
    expect(after.copy?.sequence.annotations).toMatchObject([{ name: 'Applied feature' }]);
    expect(after.dirty).toBe(false);
    expect(after.version).toBeGreaterThan(before.version);
    expect(f.records.get(f.documentId)?.copy.savedSequence.annotations).toMatchObject([
      { name: 'Applied feature' },
    ]);
    await expect(f.command(before, { kind: 'undo' })).rejects.toMatchObject({
      code: 'STALE_SEQUENCE',
      stateChanged: false,
    });
    expect(() => protection.assertCurrent()).toThrow('SEQUENCE_DOCUMENT_PROTECTION_RELEASED');
  });
  it('refuses annotation Apply over a native dirty draft and releases the rejected protection', async () => {
    const f = await fixture();
    const state = await f.command(await f.inspect(), {
      kind: 'replace-bases',
      start: 0,
      end: 4,
      bases: 'TTTT',
      expectedBases: 'AAAA',
    });
    await expect(f.owner.protectCleanDocument(f.documentId, f.path)).rejects.toThrow(
      'DIRTY_SEQUENCE_DRAFT'
    );
    expect((await f.inspect()).bases?.text).toBe('TTTTCCCCGGGG');
    expect((await f.command(state, { kind: 'discard' })).bases?.text).toBe('AAAACCCCGGGG');
  });
  it('reloads the exact external publication after an uncertain annotation abort', async () => {
    const f = await fixture();
    const before = await f.inspect();
    const protection = await f.owner.protectCleanDocument(f.documentId, f.path);
    const published = parseSequenceFileAsDocument(await readFile(f.path, 'utf8'), f.path).sequence;
    published.annotations = [
      { name: 'Retained publication', type: 'misc_feature', start: 2, end: 4, direction: 1 },
    ];
    await writeFile(f.path, serializeSequenceForInPlaceSave(published, f.path));
    protection.abort('needs-recovery');
    const after = await f.inspect();
    expect(after.copy?.sequence.annotations).toMatchObject([{ name: 'Retained publication' }]);
    expect(after.version).toBeGreaterThan(before.version);
    expect(after.dirty).toBe(false);
  });
  it('freezes biological edits during the first managed ID stamp and retains stamped IDs after discard', async () => {
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
    let state = await f.command(await f.inspect(), {
      kind: 'add-annotation',
      annotation: {
        name: 'New feature',
        type: 'misc_feature',
        color: '#888888',
        start: 1,
        end: 4,
        direction: 1,
      },
    });
    expect(state.requiresManagedAnnotationStamp).toBe(true);
    const captured = await f.owner.execute({
      documentId: f.documentId,
      expectedVersion: state.version,
      operation: { kind: 'capture-save', message: 'Stamp annotation identity' },
    });
    await started;
    try {
      expect((await f.inspect()).stampingManagedAnnotations).toBe(true);
      await expect(
        f.command(state, {
          kind: 'replace-bases',
          start: 0,
          end: 4,
          bases: 'TTTT',
          expectedBases: 'AAAA',
        })
      ).rejects.toMatchObject({ code: 'MANAGED_ANNOTATION_IDS_BUSY', stateChanged: false });
      state = await f.command(state, { kind: 'discard' });
    } finally {
      release();
    }
    const saved = await f.owner.execute({
      documentId: f.documentId,
      operation: { kind: 'publish-save', captureId: captured.captureId! },
      projection: 'document',
    });
    expect(saved).toMatchObject({
      dirty: false,
      requiresManagedAnnotationStamp: false,
      stampingManagedAnnotations: false,
    });
    const current = await f.inspect();
    const publishedId = listManagedGenBankAnnotations(await readFile(f.path, 'utf8'))[0].id;
    expect(current.copy?.sequence.annotations[0].qualifiers?.dnaforge_ann_id).toEqual([
      publishedId,
    ]);
    expect(current.copy?.savedSequence.annotations[0].qualifiers?.dnaforge_ann_id).toEqual([
      publishedId,
    ]);
    state = await f.command(saved, {
      kind: 'replace-bases',
      start: 0,
      end: 4,
      bases: 'TTTT',
      expectedBases: 'AAAA',
    });
    expect(state.bases?.text).toBe('TTTTCCCCGGGG');
  });
  it('shares typed biology edits, native history and an immutable save capture', async () => {
    const f = await fixture();
    let state = await f.inspect();
    state = await f.command(state, {
      kind: 'replace-bases',
      start: 4,
      end: 8,
      bases: 'TTTT',
      expectedBases: 'CCCC',
    });
    state = await f.command(state, {
      kind: 'add-annotation',
      annotation: {
        name: 'edited',
        type: 'misc_feature',
        start: 5,
        end: 8,
        direction: 1,
        color: '#888888',
      },
    });
    expect(state.annotationCount).toBe(1);
    state = await f.command(state, { kind: 'undo' });
    expect(state.annotationCount).toBe(0);
    state = await f.command(state, { kind: 'redo' });
    state = await f.command(state, { kind: 'save', message: 'Save native sequence' });
    expect(state.dirty).toBe(false);
    const accepted = parseSequenceFileAsDocument(await readFile(f.path, 'utf8'), f.path).sequence;
    expect(accepted.sequence).toBe('AAAATTTTGGGG');
    expect(accepted.annotations[0].name).toBe('edited');
  });
  it('persists B while captured A is writing and discards B to the in-flight accepted intent', async () => {
    let release!: () => void, begun!: () => void;
    const gate = new Promise<void>((resolve) => {
        release = resolve;
      }),
      started = new Promise<void>((resolve) => {
        begun = resolve;
      });
    const f = await fixture(async () => {
      begun();
      await gate;
    });
    let state = await f.command(await f.inspect(), {
      kind: 'replace-bases',
      start: 0,
      end: 4,
      bases: 'TTTT',
      expectedBases: 'AAAA',
    });
    const captured = await f.owner.execute({
      documentId: f.documentId,
      expectedVersion: state.version,
      operation: { kind: 'capture-save', message: 'Captured A' },
    });
    await started;
    state = await f.command(state, {
      kind: 'replace-bases',
      start: 4,
      end: 8,
      bases: 'AAAA',
      expectedBases: 'CCCC',
    });
    expect(f.records.get(f.documentId)?.copy.sequence.sequence).toBe('TTTTAAAAGGGG');
    state = await f.command(state, { kind: 'discard' });
    expect(state.bases?.text).toBe('TTTTCCCCGGGG');
    release();
    const saved = await f.owner.execute({
      documentId: f.documentId,
      operation: { kind: 'publish-save', captureId: captured.captureId! },
    });
    expect(saved.dirty).toBe(false);
    expect(
      parseSequenceFileAsDocument(await readFile(f.path, 'utf8'), f.path).sequence.sequence
    ).toBe('TTTTCCCCGGGG');
  });
  it('retains dirty history after owner restart and requires an explicit recovery decision', async () => {
    const f = await fixture();
    await f.command(await f.inspect(), {
      kind: 'replace-bases',
      start: 0,
      end: 4,
      bases: 'TTTT',
      expectedBases: 'AAAA',
    });
    await f.owner.close();
    const owner = f.create(),
      pending = await owner.execute({ documentId: f.documentId, operation: inspect });
    expect(pending.recoveryId).toBeTruthy();
    await expect(
      owner.execute({
        documentId: f.documentId,
        expectedVersion: pending.version,
        operation: { kind: 'save', message: 'Refused' },
      })
    ).rejects.toThrow('RECOVERY_PENDING');
    const restored = await owner.execute({
      documentId: f.documentId,
      expectedVersion: pending.version,
      operation: { kind: 'restore-recovery', recoveryId: pending.recoveryId! },
    });
    expect(restored.bases?.text).toBe('TTTTCCCCGGGG');
    expect(restored.dirty).toBe(true);
    expect(restored.canUndo).toBe(true);
  });
  it('refuses a changed source while preserving the exact native draft', async () => {
    const f = await fixture(),
      changed = await f.command(await f.inspect(), {
        kind: 'replace-bases',
        start: 0,
        end: 4,
        bases: 'TTTT',
        expectedBases: 'AAAA',
      });
    const before = parseSequenceFileAsDocument(await readFile(f.path, 'utf8'), f.path).sequence;
    const external = serializeSequenceForInPlaceSave(
      { ...before, sequence: 'CCCCAAAAGGGG' },
      f.path
    );
    await writeFile(f.path, external);
    await expect(
      f.command(changed, { kind: 'save', message: 'Refused overwrite' })
    ).rejects.toThrow('FILE_CHANGED');
    expect(await readFile(f.path, 'utf8')).toBe(external);
    expect((await f.inspect()).bases?.text).toBe('TTTTCCCCGGGG');
  });
});
