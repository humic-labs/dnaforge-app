import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { NativeFileDocumentOwner, type NativeFileDocumentRecord } from './file-document-owner';
import { writeTextFileAtomicInMain } from './text-file-atomic';
import type { FileDocumentClientOperation, FileDocumentSnapshot } from '../shared/file-document';
import { NativeDocumentCommandError } from '../shared/native-document-error';

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function fixture(name: string, content: string, pause?: () => Promise<void>) {
  const root = await mkdtemp(join(tmpdir(), 'dnaforge-file-document-'));
  roots.push(root);
  const path = join(root, name);
  await writeFile(path, content);
  const records = new Map<string, NativeFileDocumentRecord>();
  const owner = new NativeFileDocumentOwner({
    admit: async (path) => ({ path, workspaceRoot: root, readOnly: false, assertCurrent() {} }),
    read: async (path) => readFile(path),
    write: async (input) => {
      if (pause) await pause();
      await writeTextFileAtomicInMain(input);
    },
    loadRecord: async (path) => records.get(path),
    storeRecord: async (record) => {
      records.set(record.path, structuredClone(record));
    },
  });
  const inspect = () =>
    owner.execute({
      target: { path },
      operation: {
        kind: 'inspect',
        offset: 0,
        limit: 2000,
        rowOffset: 0,
        rowLimit: 20,
        columnOffset: 0,
        columnLimit: 20,
      },
    });
  const command = (snapshot: FileDocumentSnapshot, operation: FileDocumentClientOperation) =>
    owner.execute({
      target: { documentId: snapshot.documentId },
      expectedRevision: snapshot.revision,
      operation,
    });
  return { root, path, owner, records, inspect, command };
}

describe('native file working copies without a view', () => {
  it.each([
    [
      '\uFEFFprint("agent draft")\r\n',
      'agent draft',
      'agent durable',
      '\uFEFFprint("agent durable")\r\n',
    ],
    [
      '\uFEFF🧬 café\r\nfirst\r\nsecond\r\n',
      'first\nsecond',
      'new\nlines',
      '\uFEFF🧬 café\r\nnew\r\nlines\r\n',
    ],
  ])(
    'replaces exact inspected text through native history and save: %s',
    async (original, oldText, newText, savedText) => {
      const f = await fixture('exact.py', original);
      const initial = await f.inspect();
      expect(initial.capabilities).toContain('replace-string');
      const changed = await f.command(initial, { kind: 'replace-string', oldText, newText });
      expect(changed.text).toBe(initial.text!.replace(oldText, newText));
      expect(changed.content).toBe(savedText);
      expect(changed.dirty).toBe(true);
      expect(await readFile(f.path, 'utf8')).toBe(original);
      const undone = await f.command(changed, { kind: 'undo' });
      expect(undone).toMatchObject({ content: initial.content, canUndo: false, dirty: false });
      const redone = await f.command(undone, { kind: 'redo' });
      expect(redone.content).toBe(changed.content);
      await expect(
        f.command(initial, { kind: 'replace-string', oldText, newText })
      ).rejects.toMatchObject({
        code: 'STALE_FILE_DRAFT',
        stateChanged: false,
      });
      const saved = await f.command(redone, { kind: 'save' });
      expect(saved.dirty).toBe(false);
      expect(await readFile(f.path, 'utf8')).toBe(savedText);
      expect((await f.inspect()).documentId).toBe(initial.documentId);
    }
  );

  it.each([
    ['unchanged', 'missing', 'TEXT_NOT_FOUND'],
    ['agent draft and agent draft', 'agent draft', 'TEXT_MATCH_AMBIGUOUS'],
    ['aaa', 'aa', 'TEXT_MATCH_AMBIGUOUS'],
  ])(
    'refuses an unsafe exact replacement without changing state: %s',
    async (original, oldText, code) => {
      const f = await fixture('refused.py', original);
      const initial = await f.inspect();
      const command = f.command(initial, {
        kind: 'replace-string',
        oldText,
        newText: 'replacement',
      });
      await expect(command).rejects.toBeInstanceOf(NativeDocumentCommandError);
      await expect(command).rejects.toMatchObject({
        code,
        stateChanged: false,
        partialEffects: [],
      });
      expect(await f.inspect()).toMatchObject({
        revision: initial.revision,
        content: initial.content,
        dirty: false,
        canUndo: false,
      });
      expect(await readFile(f.path, 'utf8')).toBe(original);
    }
  );

  it('refuses invalid text ranges without changing the working copy or saved file', async () => {
    const original = '\uFEFFprint("agent draft")\r\n';
    const f = await fixture('range.py', original);
    const initial = await f.inspect();
    for (const operation of [
      { kind: 'replace-text', from: 14, to: 25, text: 'agent durable' },
      { kind: 'replace-text', from: 10, to: 9, text: 'agent durable' },
      {
        kind: 'text-transaction',
        changes: [
          { from: 8, to: 19, text: 'agent durable' },
          { from: 14, to: 25, text: 'refused' },
        ],
      },
    ] satisfies FileDocumentClientOperation[]) {
      const command = f.command(initial, operation);
      await expect(command).rejects.toBeInstanceOf(NativeDocumentCommandError);
      await expect(command).rejects.toMatchObject({
        code: 'INVALID_TEXT_RANGE',
        stateChanged: false,
        partialEffects: [],
      });
      expect(await f.inspect()).toMatchObject({
        revision: initial.revision,
        content: initial.content,
        dirty: false,
        canUndo: false,
      });
      expect(await readFile(f.path, 'utf8')).toBe(original);
    }
    const changed = await f.command(initial, {
      kind: 'replace-text',
      from: 8,
      to: 19,
      text: 'agent durable',
    });
    await f.command(changed, { kind: 'save' });
    expect(await readFile(f.path, 'utf8')).toBe('\uFEFFprint("agent durable")\r\n');
  });

  it('acknowledges a private save capture while retaining later typing before disk completion', async () => {
    const gate = Promise.withResolvers<void>();
    const f = await fixture('capture.py', 'before', () => gate.promise);
    const initial = await f.inspect();
    const a = await f.command(initial, { kind: 'replace-text', from: 0, to: 6, text: 'A' });
    const captured = await f.command(a, { kind: 'capture-save' });
    expect(captured.saveCaptureId).toBeTruthy();
    const b = await f.command(captured, { kind: 'replace-text', from: 0, to: 1, text: 'B' });
    expect(await readFile(f.path, 'utf8')).toBe('before');
    expect(f.records.get(f.path)).toMatchObject({ content: 'B', dirty: true });
    const discarded = await f.command(b, { kind: 'discard' });
    expect(discarded.content).toBe('A');
    gate.resolve();
    const receipt = await f.owner.execute({
      target: { documentId: captured.documentId },
      operation: { kind: 'await-save', saveCaptureId: captured.saveCaptureId! },
    });
    expect(receipt.dirty).toBe(false);
    expect(await readFile(f.path, 'utf8')).toBe('A');
    expect(f.records.get(f.path)).toMatchObject({ content: 'A', dirty: false });
  });
  it('refuses native edits throughout the actual lifecycle mutation', async () => {
    const f = await fixture('moving.txt', 'accepted');
    const initial = await f.inspect();
    let release!: () => void, entered!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const move = f.owner.withCleanPaths([f.path], async () => {
      entered();
      await gate;
    });
    await started;
    await expect(
      f.command(initial, { kind: 'replace-text', from: 0, to: 0, text: 'refused' })
    ).rejects.toThrow('FILE_DOCUMENT_BUSY');
    release();
    await move;
    expect((await f.inspect()).content).toBe('accepted');
  });
  it('edits, undoes and saves a closed BOM/CRLF code file with shared identity', async () => {
    const f = await fixture('closed.py', '\uFEFFprint("before")\r\n');
    const initial = await f.inspect();
    const changed = await f.command(initial, {
      kind: 'replace-text',
      from: 8,
      to: 14,
      text: 'after',
    });
    expect(changed.canUndo).toBe(true);
    const undone = await f.command(changed, { kind: 'undo' });
    expect(undone.content).toBe(initial.content);
    const redone = await f.command(undone, { kind: 'redo' });
    const saved = await f.command(redone, { kind: 'save' });
    expect(saved.dirty).toBe(false);
    expect(await readFile(f.path, 'utf8')).toBe('\uFEFFprint("after")\r\n');
    expect((await f.inspect()).documentId).toBe(initial.documentId);
    await expect(f.command(initial, { kind: 'discard' })).rejects.toThrow('STALE_FILE_DRAFT');
  });

  it('uses native table history and preserves header, multiline value, BOM and CRLF', async () => {
    const f = await fixture('closed.csv', '\uFEFFname,value\r\nalpha,"two\r\nlines"\r\n');
    const initial = await f.inspect();
    const changed = await f.command(initial, {
      kind: 'table',
      command: { kind: 'set-cell', row: 0, column: 1, value: 'quoted,"value"\nnext' },
    });
    const undone = await f.command(changed, { kind: 'undo' });
    expect(undone.content).toBe(initial.content);
    const redone = await f.command(undone, { kind: 'redo' });
    const saved = await f.command(redone, { kind: 'save' });
    expect(saved.dirty).toBe(false);
    expect(await readFile(f.path, 'utf8')).toBe(
      '\uFEFFname,value\r\nalpha,"quoted,""value""\nnext"\r\n'
    );
  });

  it.each([false, true])(
    'publishes failed-save completion without hiding another captured save: overlapping=%s',
    async (overlapping) => {
      const gate = Promise.withResolvers<void>();
      const failure = new Error('EACCES: controlled captured save failure');
      const f = await fixture('failed-capture.txt', 'before', () => gate.promise);
      const published: FileDocumentSnapshot[] = [];
      f.owner.subscribe((snapshot) => published.push(snapshot));
      const first = await f.command(await f.inspect(), {
        kind: 'replace-text',
        from: 0,
        to: 6,
        text: 'first',
      });
      const capture = (snapshot: FileDocumentSnapshot) =>
        f.owner.execute(
          {
            target: { documentId: snapshot.documentId },
            expectedRevision: snapshot.revision,
            projection: 'document',
            operation: { kind: 'capture-save' },
          },
          'renderer'
        );
      const captures = [await capture(first)];
      if (overlapping) {
        const later = await f.command(first, {
          kind: 'replace-text',
          from: 0,
          to: 5,
          text: 'later',
        });
        captures.push(await capture(later));
      }
      expect(captures.every((snapshot) => snapshot.saving)).toBe(true);
      const count = published.length;
      const outcomes = Promise.allSettled(
        captures.map((snapshot) =>
          f.owner.execute(
            {
              target: { documentId: snapshot.documentId },
              projection: 'document',
              operation: { kind: 'await-save', saveCaptureId: snapshot.saveCaptureId! },
            },
            'renderer'
          )
        )
      );
      gate.reject(failure);
      expect((await outcomes).every((result) => result.status === 'rejected')).toBe(true);
      expect(published.slice(count).map((snapshot) => snapshot.saving)).toEqual(
        overlapping ? [true, false] : [false]
      );
      expect(published.at(-1)).toMatchObject({
        saving: false,
        dirty: true,
        content: overlapping ? 'later' : 'first',
      });
      expect(await readFile(f.path, 'utf8')).toBe('before');
    }
  );

  it.each(['saved', 'write refused', 'write refused and logger unavailable'])(
    'preserves the save outcome when a completion subscriber fails: %s',
    async (outcome) => {
      const gate = Promise.withResolvers<void>();
      const entered = Promise.withResolvers<void>();
      const writeFailure = new Error('EACCES: original file write denied');
      const notificationFailure = new Error('EPIPE: renderer notification unavailable');
      const f = await fixture('notification.txt', 'before', async () => {
        entered.resolve();
        await gate.promise;
      });
      const changed = await f.command(await f.inspect(), {
        kind: 'replace-text',
        from: 0,
        to: 6,
        text: 'draft',
      });
      const save = f.command(changed, { kind: 'save' });
      const settled = save.then(
        (value) => ({ value, error: null }),
        (error: unknown) => ({ value: null, error })
      );
      await entered.promise;
      const published: FileDocumentSnapshot[] = [];
      f.owner.subscribe(() => {
        throw notificationFailure;
      });
      f.owner.subscribe((snapshot) => published.push(snapshot));
      const report = vi.spyOn(console, 'error').mockImplementation(() => {
        if (outcome.endsWith('logger unavailable')) throw new Error('Diagnostic sink unavailable');
      });
      try {
        if (outcome === 'saved') gate.resolve();
        else gate.reject(writeFailure);
        const result = await settled;
        if (outcome === 'saved') {
          expect(result.error).toBeNull();
          expect(result.value).toMatchObject({ saving: false, dirty: false });
        } else expect(result.error).toBe(writeFailure);
        expect(await readFile(f.path, 'utf8')).toBe(outcome === 'saved' ? 'draft' : 'before');
        expect(published.at(-1)).toMatchObject({ saving: false, content: 'draft' });
        expect(report).toHaveBeenCalledWith(
          expect.any(String),
          expect.objectContaining({ filePath: f.path, documentId: changed.documentId }),
          notificationFailure
        );
      } finally {
        report.mockRestore();
      }
    }
  );

  it('retains a later edit while its captured save publishes', async () => {
    let release!: () => void, begun!: () => void;
    const started = new Promise<void>((resolve) => {
      begun = resolve;
    });
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const f = await fixture('captured.txt', 'before', async () => {
      begun();
      await gate;
    });
    const first = await f.command(await f.inspect(), {
      kind: 'replace-text',
      from: 0,
      to: 6,
      text: 'saved',
    });
    const save = f.command(first, { kind: 'save' });
    await started;
    const later = await f.command(first, { kind: 'replace-text', from: 0, to: 5, text: 'newer' });
    expect(later.content).toBe('newer');
    release();
    const result = await save;
    expect(result.content).toBe('newer');
    expect(result.dirty).toBe(true);
    expect(await readFile(f.path, 'utf8')).toBe('saved');
  });

  it('refuses an outside disk edit without overwriting it or losing the draft', async () => {
    const f = await fixture('external.txt', 'before');
    const changed = await f.command(await f.inspect(), {
      kind: 'replace-text',
      from: 0,
      to: 6,
      text: 'draft',
    });
    await writeFile(f.path, 'outside');
    await expect(f.command(changed, { kind: 'save' })).rejects.toThrow('FILE_CHANGED');
    expect(await readFile(f.path, 'utf8')).toBe('outside');
    expect((await f.inspect()).content).toBe('draft');
  });
});
