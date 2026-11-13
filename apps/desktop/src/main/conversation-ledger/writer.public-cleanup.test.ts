import { mkdtempSync, rmSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { CONVERSATION_LEDGER_MANIFEST_FILENAME } from './constants';
import type { ConversationLedgerAppendInput } from './envelope';

const native = vi.hoisted(() => {
  const state: {
    root: string;
    fault: { operation: 'remove' | 'append'; path: string } | null;
    hits: number;
  } = { root: '', fault: null, hits: 0 };
  return state;
});

vi.mock('electron', () => ({ app: { getPath: () => native.root } }));
vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return {
    ...actual,
    rm: vi.fn(async (...args: Parameters<typeof actual.rm>) => {
      if (native.fault?.operation === 'remove' && args[0] === native.fault.path) {
        native.hits++;
        throw Object.assign(new Error('Controlled shadow removal refused'), { code: 'EACCES' });
      }
      return actual.rm(...args);
    }),
    appendFile: vi.fn(async (...args: Parameters<typeof actual.appendFile>) => {
      if (native.fault?.operation === 'append' && args[0] === native.fault.path) {
        native.hits++;
        throw Object.assign(new Error('Controlled shadow append refused'), { code: 'EACCES' });
      }
      return actual.appendFile(...args);
    }),
  };
});

import {
  ConversationLedgerWriter,
  appendConversationLedgerShadowEvent,
  getDefaultConversationLedgerWriter,
  unlinkConversationLedgerShadow,
} from './writer';

afterEach(() => {
  native.fault = null;
  vi.restoreAllMocks();
  if (native.root) rmSync(native.root, { recursive: true, force: true });
});

it('preserves failed public shadow cleanup and recovers its queue without claiming removal', async () => {
  native.root = mkdtempSync(join(tmpdir(), 'public-shadow-boundary-'));
  const writer = await getDefaultConversationLedgerWriter();
  const input: ConversationLedgerAppendInput = {
    conversation_id: 'controlled-public-shadow',
    source: 'cli:codex',
    provider: null,
    model: null,
    stream_event_type: 'item.completed',
    payload: { controlled: true },
  };
  await writer.append(input);
  const path = writer.getConversationPath(input.conversation_id);
  const manifestPath = join(
    ConversationLedgerWriter.defaultRoot(native.root),
    CONVERSATION_LEDGER_MANIFEST_FILENAME
  );
  const before = await readFile(path, 'utf8');
  const manifestBefore = await readFile(manifestPath, 'utf8');
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  native.fault = { operation: 'remove', path };
  await expect(unlinkConversationLedgerShadow(input.conversation_id)).resolves.toBeUndefined();
  await new Promise<void>((resolve) => setImmediate(resolve));
  expect(native.hits).toBe(1);
  expect(warn).toHaveBeenCalledWith(
    '[ConversationLedger] Shadow unlink failed:',
    expect.objectContaining({ code: 'EACCES' })
  );
  expect(await readFile(path, 'utf8')).toBe(before);
  expect(await readFile(manifestPath, 'utf8')).toBe(manifestBefore);
  native.fault = null;
  await expect(unlinkConversationLedgerShadow(input.conversation_id)).resolves.toBeUndefined();
  await expect(readFile(path)).rejects.toMatchObject({ code: 'ENOENT' });
  expect((await writer.readManifest()).conversations).toEqual([]);
  native.fault = { operation: 'append', path };
  await expect(appendConversationLedgerShadowEvent(input)).resolves.toBeNull();
  await new Promise<void>((resolve) => setImmediate(resolve));
  expect(native.hits).toBe(2);
  await expect(readFile(path)).rejects.toMatchObject({ code: 'ENOENT' });
  expect((await writer.readManifest()).conversations).toEqual([]);
  native.fault = null;
  await expect(appendConversationLedgerShadowEvent(input)).resolves.toMatchObject({
    conversation_id: input.conversation_id,
  });
  expect(await writer.readEvents(input.conversation_id)).toHaveLength(1);
});
