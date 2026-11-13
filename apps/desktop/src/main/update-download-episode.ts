import { randomUUID } from 'node:crypto';
import type Database from 'better-sqlite3';

const SETTING = '_update_download_episode';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

interface DownloadEpisode {
  operationId: string;
  sourceVersion: string;
  candidate: string;
  startedAtMs: number;
  parentActionId?: string;
}

type DownloadEpisodeState =
  | { phase: 'idle' }
  | { phase: 'downloading'; episode: DownloadEpisode & { completedAtMs: null; failed?: false } }
  | { phase: 'completed'; episode: DownloadEpisode & { completedAtMs: number; failed?: false } }
  | { phase: 'failed'; episode: DownloadEpisode & { completedAtMs: number; failed: true } };

export class UpdateDownloadEpisodes {
  private state: DownloadEpisodeState = { phase: 'idle' };

  constructor(private readonly database?: Database.Database) {}

  get operationId(): string | undefined {
    return this.state.phase === 'idle' ? undefined : this.state.episode.operationId;
  }

  begin(candidate: string, sourceVersion: string, nowMs: number, parentActionId?: string): boolean {
    if (
      candidate &&
      this.state.phase !== 'idle' &&
      this.state.phase !== 'failed' &&
      this.state.episode.candidate === candidate &&
      this.state.episode.sourceVersion === sourceVersion
    )
      return false;
    const retained = this.read();
    this.state =
      candidate &&
      retained.phase !== 'idle' &&
      retained.phase !== 'failed' &&
      retained.episode.candidate === candidate &&
      retained.episode.sourceVersion === sourceVersion
        ? retained
        : {
            phase: 'downloading',
            episode: {
              operationId: randomUUID(),
              candidate,
              sourceVersion,
              startedAtMs: nowMs,
              completedAtMs: null,
              ...(parentActionId ? { parentActionId } : {}),
            },
          };
    this.persist();
    return this.state !== retained;
  }

  complete(
    candidate: string,
    sourceVersion: string,
    nowMs: number
  ): {
    newEpisode: boolean;
    operation_id: string;
    occurred_at_ms: number;
    download_duration_ms: number;
    origin_started_at_ms: number;
    parent_action_id?: string;
  } | null {
    let newEpisode = false;
    if (
      candidate ||
      this.state.phase !== 'downloading' ||
      this.state.episode.sourceVersion !== sourceVersion
    ) {
      newEpisode = this.begin(candidate, sourceVersion, nowMs);
    }
    if (this.state.phase !== 'downloading') return null;
    const episode = this.state.episode;
    this.state = { phase: 'completed', episode: { ...episode, completedAtMs: nowMs } };
    this.persist();
    return {
      newEpisode,
      operation_id: episode.operationId,
      occurred_at_ms: nowMs,
      origin_started_at_ms: episode.startedAtMs,
      ...(episode.parentActionId ? { parent_action_id: episode.parentActionId } : {}),
      download_duration_ms: Math.max(0, nowMs - episode.startedAtMs),
    };
  }

  fail(
    nowMs: number
  ): { operation_id: string; origin_started_at_ms: number; occurred_at_ms: number } | null {
    if (this.state.phase !== 'downloading') return null;
    const episode = this.state.episode;
    this.state = { phase: 'failed', episode: { ...episode, completedAtMs: nowMs, failed: true } };
    this.persist();
    return {
      operation_id: episode.operationId,
      origin_started_at_ms: episode.startedAtMs,
      occurred_at_ms: nowMs,
    };
  }

  private read(): DownloadEpisodeState {
    try {
      const row = this.database
        ?.prepare('SELECT value FROM settings WHERE key = ?')
        .get(SETTING) as { value: string } | undefined;
      if (!row) return { phase: 'idle' };
      const value: unknown = JSON.parse(row.value);
      if (
        !value ||
        typeof value !== 'object' ||
        !('operationId' in value) ||
        typeof value.operationId !== 'string' ||
        !UUID.test(value.operationId) ||
        ('parentActionId' in value &&
          (typeof value.parentActionId !== 'string' || !UUID.test(value.parentActionId))) ||
        !('candidate' in value) ||
        typeof value.candidate !== 'string' ||
        !value.candidate ||
        !('sourceVersion' in value) ||
        typeof value.sourceVersion !== 'string' ||
        !('startedAtMs' in value) ||
        typeof value.startedAtMs !== 'number' ||
        !Number.isSafeInteger(value.startedAtMs) ||
        value.startedAtMs < 0 ||
        value.startedAtMs > Date.now() + 300_000 ||
        ('failed' in value && typeof value.failed !== 'boolean') ||
        !('completedAtMs' in value) ||
        (value.completedAtMs !== null &&
          (typeof value.completedAtMs !== 'number' ||
            !Number.isSafeInteger(value.completedAtMs) ||
            value.completedAtMs < value.startedAtMs))
      )
        return { phase: 'idle' };
      const episode: DownloadEpisode = {
        operationId: value.operationId,
        candidate: value.candidate,
        sourceVersion: value.sourceVersion,
        startedAtMs: value.startedAtMs,
        ...('parentActionId' in value && typeof value.parentActionId === 'string'
          ? { parentActionId: value.parentActionId }
          : {}),
      };
      if ('failed' in value && value.failed === true) {
        return value.completedAtMs === null
          ? { phase: 'idle' }
          : {
              phase: 'failed',
              episode: { ...episode, completedAtMs: value.completedAtMs, failed: true },
            };
      }
      const failed = 'failed' in value ? { failed: false as const } : {};
      return value.completedAtMs === null
        ? { phase: 'downloading', episode: { ...episode, completedAtMs: null, ...failed } }
        : {
            phase: 'completed',
            episode: { ...episode, completedAtMs: value.completedAtMs, ...failed },
          };
    } catch {
      return { phase: 'idle' };
    }
  }

  private persist(): void {
    if (this.state.phase === 'idle' || !this.state.episode.candidate) return;
    try {
      this.database
        ?.prepare(
          'INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at'
        )
        .run(SETTING, JSON.stringify(this.state.episode), Date.now());
    } catch {
      console.warn('[AutoUpdater] Download episode persistence unavailable.');
    }
  }
}
