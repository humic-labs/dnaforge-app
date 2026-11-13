// @vitest-environment node
import { afterEach, describe, expect, it } from 'vitest';
import type Database from 'better-sqlite3';
import { createTestDb } from './__tests__/test-db';
import { UpdateDownloadEpisodes } from './update-download-episode';

const databases: Database.Database[] = [];
function database() {
  const db = createTestDb();
  db.exec('CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT, updated_at INTEGER)');
  databases.push(db);
  return db;
}
function retained(db: Database.Database) {
  return JSON.parse(
    (
      db.prepare('SELECT value FROM settings WHERE key=?').get('_update_download_episode') as {
        value: string;
      }
    ).value
  );
}
afterEach(() => {
  for (const db of databases.splice(0)) db.close();
});

describe('download episode transitions', () => {
  it('coalesces an active candidate without changing its origin', () => {
    const db = database();
    const episodes = new UpdateDownloadEpisodes(db);
    expect(episodes.fail(90)).toBeNull();
    expect(episodes.begin('candidate-a', '1.0.0', 100)).toBe(true);
    const operationId = episodes.operationId;
    expect(episodes.begin('candidate-a', '1.0.0', 200)).toBe(false);
    expect(episodes.operationId).toBe(operationId);
    expect(retained(db)).toMatchObject({ operationId, startedAtMs: 100, completedAtMs: null });
    expect(episodes.complete('candidate-a', '1.0.0', 300)).toMatchObject({
      operation_id: operationId,
      download_duration_ms: 200,
      newEpisode: false,
    });
  });

  it('emits completion once and retains the same terminal identity after reopening', () => {
    const db = database();
    const episodes = new UpdateDownloadEpisodes(db);
    episodes.begin('candidate-a', '1.0.0', 100);
    const operationId = episodes.operationId;
    expect(episodes.complete('candidate-a', '1.0.0', 200)).not.toBeNull();
    expect(episodes.complete('candidate-a', '1.0.0', 300)).toBeNull();
    expect(episodes.fail(400)).toBeNull();
    const reopened = new UpdateDownloadEpisodes(db);
    expect(reopened.begin('candidate-a', '1.0.0', 500)).toBe(false);
    expect(reopened.operationId).toBe(operationId);
    expect(reopened.complete('candidate-a', '1.0.0', 600)).toBeNull();
    expect(retained(db).completedAtMs).toBe(200);
  });

  it('makes a failed download terminal and gives its retry a new operation', () => {
    const db = database();
    const episodes = new UpdateDownloadEpisodes(db);
    episodes.begin('candidate-a', '1.0.0', 100);
    const failedId = episodes.operationId;
    expect(episodes.fail(200)).toEqual({
      operation_id: failedId,
      origin_started_at_ms: 100,
      occurred_at_ms: 200,
    });
    expect(episodes.fail(300)).toBeNull();
    expect(retained(db)).toMatchObject({ failed: true, completedAtMs: 200 });
    const retry = new UpdateDownloadEpisodes(db);
    expect(retry.begin('candidate-a', '1.0.0', 400)).toBe(true);
    expect(retry.operationId).not.toBe(failedId);
    expect(retry.complete('candidate-a', '1.0.0', 450)).toMatchObject({ download_duration_ms: 50 });
  });

  it('changes ownership when either the candidate or installed source version changes', () => {
    const episodes = new UpdateDownloadEpisodes(database());
    episodes.begin('candidate-a', '1.0.0', 100);
    const first = episodes.operationId;
    expect(episodes.begin('candidate-b', '1.0.0', 200)).toBe(true);
    const second = episodes.operationId;
    expect(second).not.toBe(first);
    expect(episodes.begin('candidate-b', '1.1.0', 300)).toBe(true);
    expect(episodes.operationId).not.toBe(second);
  });

  it('reconstructs the existing flat persisted record without emitting a second completion', () => {
    const db = database();
    const legacy = {
      operationId: '11111111-1111-4111-8111-111111111111',
      sourceVersion: '1.0.0',
      candidate: 'candidate-a',
      startedAtMs: 100,
      completedAtMs: 200,
      parentActionId: '22222222-2222-4222-8222-222222222222',
    };
    db.prepare('INSERT INTO settings VALUES(?,?,?)').run(
      '_update_download_episode',
      JSON.stringify(legacy),
      200
    );
    const episodes = new UpdateDownloadEpisodes(db);
    expect(episodes.begin('candidate-a', '1.0.0', 300)).toBe(false);
    expect(episodes.complete('candidate-a', '1.0.0', 400)).toBeNull();
    expect(retained(db)).toEqual(legacy);
  });

  it('can record a completed candidate when no start event was observed', () => {
    const episodes = new UpdateDownloadEpisodes(database());
    expect(episodes.complete('candidate-a', '1.0.0', 200)).toMatchObject({
      newEpisode: true,
      origin_started_at_ms: 200,
      download_duration_ms: 0,
    });
  });
});
