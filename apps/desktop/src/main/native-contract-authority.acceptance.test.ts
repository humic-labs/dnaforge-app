import { mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { GenomeDataWorkerClient } from '@waypoint/genome-data';
import type { GenomeDataWorkerLike } from '../../../../packages/core/genome-data/src/worker-client';
import type { GenomeDataWorkerRequest } from '../../../../packages/core/genome-data/src/worker-protocol';
import { trackViewCommandResultSchema } from '../shared/track-view-commands';
import {
  createReplicaPullJournal,
  replicaPullStagingPrefix,
  type ReplicaPullJournal,
} from './workspace-sync-replica-journal';

type JournalFixture = {
  path: string;
  readonly value: ReplicaPullJournal;
  update?: (patch: Partial<Pick<ReplicaPullJournal, 'phase' | 'newHead'>>) => void;
  markFilesInstalled?: () => void;
  markGitCommitted?: (head: string) => void;
  markSqliteCommitted?: () => void;
  rollback?: (restore: () => Promise<void>) => Promise<void>;
  finishRollback?: (cleanup: () => Promise<void>) => Promise<void>;
};

function transition(
  journal: JournalFixture,
  phase: 'files_installed' | 'git_committed' | 'sqlite_committed' | 'rolled_back',
  head?: string
) {
  if (journal.update)
    return journal.update({ phase, ...(head !== undefined ? { newHead: head } : {}) });
  if (phase === 'files_installed') return journal.markFilesInstalled!();
  if (phase === 'git_committed') return journal.markGitCommitted!(head!);
  if (phase === 'sqlite_committed') return journal.markSqliteCommitted!();
  return journal.rollback!(() => Promise.resolve()).then(() =>
    journal.finishRollback!(() => Promise.resolve())
  );
}

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
function journalFixture() {
  const root = mkdtempSync(join(tmpdir(), 'dna4450-journal-'));
  roots.push(root);
  const repoPath = join(root, 'repo');
  const staging = join(root, `${replicaPullStagingPrefix('acceptance-workspace')}fixture`);
  mkdirSync(repoPath);
  mkdirSync(staging);
  const journal: JournalFixture = createReplicaPullJournal(staging, {
    repoPath,
    workspaceUuid: 'acceptance-workspace',
    oldHead: 'a'.repeat(40),
    targetRemoteVersionId: 'accepted-version',
    targetRemoteVersionNumber: 2,
    operationPaths: [],
    backups: [],
    installs: [],
  });
  return { journal, staging };
}

describe(' replica journal transition ownership', () => {
  it('refuses Git acceptance before the files have been installed without changing either journal', () => {
    const { journal } = journalFixture();
    const before = readFileSync(journal.path, 'utf8');
    expect(() => transition(journal, 'git_committed', 'b'.repeat(40))).toThrow();
    expect(journal.value.phase).toBe('prepared');
    expect(journal.value.newHead).toBeNull();
    expect(readFileSync(journal.path, 'utf8')).toBe(before);
  });
  it('refuses SQLite acceptance before Git and keeps the in-memory accepted state', () => {
    const { journal } = journalFixture();
    transition(journal, 'files_installed');
    const before = readFileSync(journal.path, 'utf8');
    expect(() => transition(journal, 'sqlite_committed')).toThrow();
    expect(journal.value.phase).toBe('files_installed');
    expect(journal.value.newHead).toBeNull();
    expect(readFileSync(journal.path, 'utf8')).toBe(before);
  });
  it('leaves accepted state unchanged when publishing the next journal fails', () => {
    const { journal, staging } = journalFixture();
    const before = structuredClone(journal.value);
    const moved = `${staging}-preserved`;
    renameSync(staging, moved);
    try {
      expect(() => transition(journal, 'files_installed')).toThrow();
      expect(journal.value).toEqual(before);
      expect(JSON.parse(readFileSync(join(moved, 'replica-pull-journal.json'), 'utf8'))).toEqual(
        before
      );
    } finally {
      renameSync(moved, staging);
    }
  });
  it('retains the complete successful sequence and refuses to reopen a rolled-back transaction', async () => {
    const { journal } = journalFixture();
    transition(journal, 'files_installed');
    transition(journal, 'git_committed', 'b'.repeat(40));
    transition(journal, 'sqlite_committed');
    expect(JSON.parse(readFileSync(journal.path, 'utf8'))).toMatchObject({
      phase: 'sqlite_committed',
      newHead: 'b'.repeat(40),
    });
    const other = journalFixture().journal;
    transition(other, 'files_installed');
    await transition(other, 'rolled_back');
    const before = readFileSync(other.path, 'utf8');
    expect(() => transition(other, 'git_committed', 'c'.repeat(40))).toThrow();
    expect(other.value.phase).toBe('rolled_back');
    expect(readFileSync(other.path, 'utf8')).toBe(before);
  });
});

const saved = {
  ok: true,
  operation: 'create',
  documentId: 'view-1',
  name: 'Comparison',
  path: '/workspace/comparison.dnaforge-track-view.json',
  revision: 'a'.repeat(64),
  referenceId: 'assembly-1',
  viewport: { start0: 0, end0: 100 },
  tracks: [],
};
describe(' complete Track View results', () => {
  it.each(['references', 'inspect', 'create'])(
    'rejects an empty successful %s result',
    (operation) => {
      expect(trackViewCommandResultSchema.safeParse({ ok: true, operation }).success).toBe(false);
    }
  );
  it.each(['documentId', 'path', 'revision', 'referenceId', 'viewport', 'tracks'])(
    'requires %s on a saved result',
    (key) => {
      const incomplete: Record<string, unknown> = { ...saved };
      delete incomplete[key];
      expect(trackViewCommandResultSchema.safeParse(incomplete).success).toBe(false);
    }
  );
  it('accepts complete references and both saved-document operations', () => {
    expect(
      trackViewCommandResultSchema.safeParse({ ok: true, operation: 'references', references: [] })
        .success
    ).toBe(true);
    expect(trackViewCommandResultSchema.safeParse(saved).success).toBe(true);
    expect(trackViewCommandResultSchema.safeParse({ ...saved, operation: 'inspect' }).success).toBe(
      true
    );
  });
});

function transport() {
  const messages: GenomeDataWorkerRequest[] = [];
  const worker: GenomeDataWorkerLike = {
    postMessage: (message) => {
      messages.push(message);
    },
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  };
  return { worker, messages, client: new GenomeDataWorkerClient(worker) };
}
async function settled(promise: Promise<unknown>) {
  return Promise.race([
    promise.then(
      (value) => ({ status: 'resolved', value }),
      (value) => ({ status: 'rejected', value })
    ),
    new Promise<{ status: string; value?: unknown }>((resolve) =>
      setImmediate(() => resolve({ status: 'pending' }))
    ),
  ]);
}
describe(' genome worker lifetime', () => {
  it('rejects pending reads and searches, removes abort listeners and closes idempotently', async () => {
    const { client, worker, messages } = transport();
    const readAbort = new AbortController();
    const searchAbort = new AbortController();
    const readRemove = vi.spyOn(readAbort.signal, 'removeEventListener');
    const searchRemove = vi.spyOn(searchAbort.signal, 'removeEventListener');
    const read = settled(client.getSequence('chr1', 0, 3, { signal: readAbort.signal }));
    const iterator = client
      .searchSequence('chr1', 'ACG', { signal: searchAbort.signal })
      [Symbol.asyncIterator]();
    const search = settled(iterator.next());
    await client.close();
    await client.close();
    expect((await read).status).toBe('rejected');
    expect((await search).status).toBe('rejected');
    expect(readRemove).toHaveBeenCalledWith('abort', expect.any(Function));
    expect(searchRemove).toHaveBeenCalledWith('abort', expect.any(Function));
    expect(worker.removeEventListener).toHaveBeenCalled();
    const count = messages.length;
    readAbort.abort();
    searchAbort.abort();
    expect(messages).toHaveLength(count);
  });
  it('refuses new reads and searches after close without dispatching worker messages', async () => {
    const { client, messages } = transport();
    await client.close();
    const count = messages.length;
    const read = await settled(Promise.resolve().then(() => client.getSequence('chr1', 0, 3)));
    const search = await settled(
      Promise.resolve().then(() =>
        client.searchSequence('chr1', 'ACG')[Symbol.asyncIterator]().next()
      )
    );
    expect(read.status).toBe('rejected');
    expect(search.status).toBe('rejected');
    expect(messages).toHaveLength(count);
  });
});
