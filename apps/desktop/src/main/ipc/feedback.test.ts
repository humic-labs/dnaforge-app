import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { join } from 'path';
import { mkdtempSync, rmSync, readFileSync, statSync, writeFileSync, mkdirSync } from 'fs';
import { tmpdir } from 'os';

function stubPost(mock: ReturnType<typeof vi.fn>): void {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, options: RequestInit) => {
      if (options.method === 'GET')
        return { ok: true, json: async () => ({ protocol: 'dnaforge.feedback.v1' }) };
      const response = await mock(url, options);
      return {
        ...response,
        json: async () => ({ submission_id: JSON.parse(String(options.body)).submission_id }),
      };
    })
  );
}

let tempDir: string;

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), 'feedback-test-'));
  vi.stubGlobal('fetch', vi.fn());
});

afterEach(() => {
  rmSync(tempDir, { recursive: true, force: true });
  vi.restoreAllMocks();
});

const { sendFeedback, flushPendingFeedback, getInstallId } = await import('./feedback');

describe('sendFeedback', () => {
  it('POSTs feedback to the configured URL', async () => {
    const mockFetch = vi.fn().mockResolvedValue({ ok: true, status: 201 });
    stubPost(mockFetch);

    const result = await sendFeedback(
      { message: 'Great app!', app_version: '1.0.0', platform_info: 'darwin arm64' },
      'http://127.0.0.1:8765/api/feedback',
      tempDir
    );

    expect(result.success).toBe(true);
    expect(mockFetch).toHaveBeenCalledWith(
      'http://127.0.0.1:8765/api/feedback',
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({ 'Content-Type': 'application/json' }),
      })
    );
  });

  it('saves to pending queue on network failure', async () => {
    stubPost(vi.fn().mockRejectedValue(new Error('Network error')));

    const result = await sendFeedback(
      { message: 'test feedback', app_version: '1.0.0' },
      'http://127.0.0.1:8765/api/feedback',
      tempDir
    );

    expect(result.success).toBe(false);
    expect(result.queued).toBe(true);

    const queuePath = join(tempDir, 'pending-feedback.json');
    const queue = JSON.parse(readFileSync(queuePath, 'utf-8'));
    expect(queue).toHaveLength(1);
    expect(queue[0].message).toBe('test feedback');
  });

  it('saves to pending queue on non-2xx response', async () => {
    stubPost(vi.fn().mockResolvedValue({ ok: false, status: 500 }));

    const result = await sendFeedback(
      { message: 'test', app_version: '1.0.0' },
      'http://127.0.0.1:8765/api/feedback',
      tempDir
    );

    expect(result.success).toBe(false);
    expect(result.queued).toBe(true);
  });
});

describe('flushPendingFeedback', () => {
  it('retries queued items and removes on success', async () => {
    const queuePath = join(tempDir, 'pending-feedback.json');
    writeFileSync(
      queuePath,
      JSON.stringify([
        { message: 'queued msg', app_version: '1.0.0', timestamp: new Date().toISOString() },
      ])
    );

    stubPost(vi.fn().mockResolvedValue({ ok: true, status: 201 }));

    await flushPendingFeedback('http://127.0.0.1:8765/api/feedback', tempDir);

    const remaining = JSON.parse(readFileSync(queuePath, 'utf-8'));
    expect(remaining).toHaveLength(0);
  });

  it('keeps failed items in queue', async () => {
    const queuePath = join(tempDir, 'pending-feedback.json');
    writeFileSync(
      queuePath,
      JSON.stringify([
        { message: 'will fail', app_version: '1.0.0', timestamp: new Date().toISOString() },
      ])
    );

    stubPost(vi.fn().mockRejectedValue(new Error('still offline')));

    await flushPendingFeedback('http://127.0.0.1:8765/api/feedback', tempDir);

    const remaining = JSON.parse(readFileSync(queuePath, 'utf-8'));
    expect(remaining).toHaveLength(1);
  });

  it('handles corrupted queue file gracefully', async () => {
    const queuePath = join(tempDir, 'pending-feedback.json');
    writeFileSync(queuePath, 'not valid json{{{');

    await expect(
      flushPendingFeedback('http://127.0.0.1:8765/api/feedback', tempDir)
    ).resolves.not.toThrow();
  });

  it('handles missing queue file gracefully', async () => {
    await expect(
      flushPendingFeedback('http://127.0.0.1:8765/api/feedback', tempDir)
    ).resolves.not.toThrow();
  });
});

describe('getInstallId', () => {
  it('generates and persists a UUID on first call', () => {
    const id = getInstallId(tempDir);
    expect(id).toMatch(/^[0-9a-f-]{36}$/);
    expect(readFileSync(join(tempDir, 'install-id'), 'utf8')).toBe(id);
    expect(statSync(join(tempDir, 'install-id')).mode & 0o777).toBe(0o600);

    const id2 = getInstallId(tempDir);
    expect(id2).toBe(id);
  });

  it('reads existing install ID from file', () => {
    const configDir = tempDir;
    writeFileSync(join(configDir, 'install-id'), '550E8400-E29B-41D4-A716-446655440000');

    const id = getInstallId(configDir);
    expect(id).toBe('550e8400-e29b-41d4-a716-446655440000');
  });

  it.each(['', 'existing-uuid-1234', '550e8400-e29b-01d4-a716-446655440000'])(
    'replaces an invalid persisted install ID %j with one valid UUID',
    (persisted) => {
      writeFileSync(join(tempDir, 'install-id'), persisted);

      const id = getInstallId(tempDir);

      expect(id).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
      );
      expect(readFileSync(join(tempDir, 'install-id'), 'utf8')).toBe(id);
    }
  );

  it('keeps one process-stable UUID when the install-id path cannot be written', () => {
    const notDirectory = join(tempDir, 'not-a-directory');
    writeFileSync(notDirectory, 'blocked');
    const blockedPath = join(notDirectory, 'child');

    const first = getInstallId(blockedPath);
    const second = getInstallId(blockedPath);

    expect(first).toMatch(/^[0-9a-f-]{36}$/);
    expect(second).toBe(first);
  });
});

describe('durable feedback ownership regressions', () => {
  const url = 'http://127.0.0.1:8765/api/feedback';
  function seed(messages: string[]) {
    const items = messages.map((message) => ({ message, timestamp: '2026-10-14T20:00:00.000Z' }));
    writeFileSync(join(tempDir, 'pending-feedback.json'), JSON.stringify(items));
    return items;
  }
  function queued() {
    return JSON.parse(readFileSync(join(tempDir, 'pending-feedback.json'), 'utf8'));
  }

  it('refuses to promise saved feedback when the profile is not writable', async () => {
    const notDirectory = join(tempDir, 'not-directory');
    writeFileSync(notDirectory, 'unchanged');
    stubPost(vi.fn().mockRejectedValue(new Error('offline')));
    const result = await sendFeedback(
      { message: 'harmless storage decoy' },
      url,
      join(notDirectory, 'child')
    );
    expect(result.success).toBe(false);
    expect(result.queued).not.toBe(true);
    expect(readFileSync(notDirectory, 'utf8')).toBe('unchanged');
  });

  it('refuses item51 without evicting any of the50 accepted items', async () => {
    const original = seed(Array.from({ length: 50 }, (_, i) => `harmless item ${i}`));
    stubPost(vi.fn().mockRejectedValue(new Error('offline')));
    const result = await sendFeedback({ message: 'harmless item51' }, url, tempDir);
    expect(result.queued).not.toBe(true);
    expect(queued().map((item: { message: string }) => item.message)).toEqual(
      original.map((item) => item.message)
    );
  });

  it.each(['not-json', '{}', '[null]', '[{"message":42}]'])(
    'retains malformed evidence %s without replacing it',
    async (corrupt) => {
      const path = join(tempDir, 'pending-feedback.json');
      writeFileSync(path, corrupt);
      const fetch = vi.fn().mockRejectedValue(new Error('offline'));
      stubPost(fetch);
      const result = await sendFeedback({ message: 'harmless corruption decoy' }, url, tempDir);
      expect(result.queued).not.toBe(true);
      expect(fetch).not.toHaveBeenCalled();
      expect(readFileSync(path, 'utf8')).toBe(corrupt);
    }
  );

  it.each([true, false])('retains concurrent B when draining A succeeds=%s', async (ok) => {
    seed(['harmless A']);
    let release!: (response: { ok: boolean; status: number }) => void;
    const first = new Promise<{ ok: boolean; status: number }>((resolve) => {
      release = resolve;
    });
    stubPost(vi.fn().mockReturnValueOnce(first).mockRejectedValue(new Error('offline B')));
    const draining = flushPendingFeedback(url, tempDir);
    const b = await sendFeedback({ message: 'harmless B' }, url, tempDir);
    expect(b.queued).toBe(true);
    release({ ok, status: ok ? 201 : 503 });
    await draining;
    expect(queued().some((item: { message: string }) => item.message === 'harmless B')).toBe(true);
    expect(queued().some((item: { message: string }) => item.message === 'harmless A')).toBe(!ok);
  });

  it('does not automatically retry a permanent400 as a pending transient failure', async () => {
    stubPost(vi.fn().mockResolvedValue({ ok: false, status: 400 }));
    const result = await sendFeedback({ message: 'harmless permanent refusal' }, url, tempDir);
    expect(result.success).toBe(false);
    expect(result.queued).not.toBe(true);
    const calls = vi.mocked(fetch).mock.calls.length;
    await flushPendingFeedback(url, tempDir);
    expect(vi.mocked(fetch).mock.calls.length).toBe(calls);
  });

  it('rejects invalid payloads before touching storage or transport', async () => {
    const fetch = vi.fn();
    stubPost(fetch);
    for (const message of ['', ' '.repeat(5), 'x'.repeat(2001)]) {
      const result = await sendFeedback({ message }, url, tempDir);
      expect(result.success).toBe(false);
      expect(result.queued).not.toBe(true);
    }
    expect(fetch).not.toHaveBeenCalled();
  });
});
