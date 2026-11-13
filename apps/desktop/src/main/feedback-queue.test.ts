import type { FeedbackReceipt } from '../shared/feedback';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  cancelFeedback,
  drainFeedback,
  FEEDBACK_TIMEOUT_MS,
  submitFeedback,
  configureFeedbackTelemetry,
  replayFeedbackTelemetry,
} from './feedback-queue';

vi.mock('node:fs', async (original) => {
  const actual = await original<typeof import('node:fs')>();
  return {
    ...actual,
    writeFileSync: vi.fn(actual.writeFileSync),
    fsyncSync: vi.fn(actual.fsyncSync),
    renameSync: vi.fn(actual.renameSync),
  };
});
const id = '33690000-0000-4000-8000-000000000001';
let profile: string;
function rows(): Array<{ submission_id: string; message: string; queue_state: string }> {
  return JSON.parse(fs.readFileSync(join(profile, 'pending-feedback.json'), 'utf8'));
}
function transport(post: (body: { submission_id: string }) => Promise<Response>) {
  const fetch = vi.fn(async (_url: string, options: RequestInit) =>
    options.method === 'GET'
      ? Response.json({ protocol: 'dnaforge.feedback.v1' })
      : post(JSON.parse(String(options.body)))
  );
  vi.stubGlobal('fetch', fetch);
  return fetch;
}
function send() {
  return submitFeedback(
    { message: 'harmless durable decoy', submission_id: id },
    'http://127.0.0.1/contained-feedback',
    profile,
    () => 'synthetic-install'
  );
}

beforeEach(() => {
  profile = fs.mkdtempSync(join(tmpdir(), 'fixture-queue-'));
});
afterEach(() => {
  configureFeedbackTelemetry(null);
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  fs.rmSync(profile, { recursive: true, force: true });
});

describe('feedback durable transport and recovery', () => {
  it.each([
    ['write', 'EACCES'],
    ['write', 'ENOSPC'],
    ['sync', 'EIO'],
    ['rename', 'EINTR'],
  ])('preserves earlier accepted bytes if %s fails with %s', async (phase, code) => {
    transport(async () => {
      throw new Error('contained offline');
    });
    await send();
    const previous = fs.readFileSync(join(profile, 'pending-feedback.json'), 'utf8');
    const fail = () => {
      throw Object.assign(new Error('injected storage failure'), { code });
    };
    if (phase === 'write') vi.mocked(fs.writeFileSync).mockImplementationOnce(fail);
    if (phase === 'sync') vi.mocked(fs.fsyncSync).mockImplementationOnce(fail);
    if (phase === 'rename') vi.mocked(fs.renameSync).mockImplementationOnce(fail);
    const result = await submitFeedback(
      { message: 'harmless newer decoy' },
      'http://127.0.0.1/contained-feedback',
      profile,
      () => 'synthetic-install'
    );
    expect(result).toMatchObject({ success: false, queued: false, error: 'storage_unavailable' });
    expect(fs.readFileSync(join(profile, 'pending-feedback.json'), 'utf8')).toBe(previous);
  });

  it('bounds a transport which ignores AbortSignal and preserves the committed item', async () => {
    vi.useFakeTimers();
    transport(async () => new Promise<Response>(() => {}));
    const pending = send();
    await vi.advanceTimersByTimeAsync(FEEDBACK_TIMEOUT_MS);
    expect(await pending).toMatchObject({
      success: false,
      queued: true,
      error: 'timeout',
      submission_id: id,
    });
    expect(rows()).toMatchObject([{ submission_id: id, queue_state: 'pending' }]);
  });

  it('does not POST to an older service which cannot guarantee idempotent retries', async () => {
    const fetch = vi.fn().mockResolvedValue(Response.json({ error: 'legacy' }, { status: 405 }));
    vi.stubGlobal('fetch', fetch);
    expect(await send()).toMatchObject({
      success: false,
      queued: true,
      error: 'service_unavailable',
    });
    expect(fetch.mock.calls.every((call) => call[1].method === 'GET')).toBe(true);
  });

  it('holds cancellation durably and never sends a new request during restart drain', async () => {
    const fetch = transport(async () => new Promise<Response>(() => {}));
    const pending = send();
    expect(cancelFeedback(profile, id)).toMatchObject({ queued: false, error: 'cancelled' });
    expect(await pending).toMatchObject({ queued: false, error: 'cancelled' });
    expect(rows()).toMatchObject([{ submission_id: id, queue_state: 'held' }]);
    const count = fetch.mock.calls.length;
    await drainFeedback('http://127.0.0.1/contained-feedback', profile);
    expect(fetch).toHaveBeenCalledTimes(count);
  });

  it('reuses the durable key when backend acceptance loses its response', async () => {
    const stored = new Set<string>();
    let loseResponse = true;
    transport(async (body) => {
      stored.add(body.submission_id);
      if (loseResponse) {
        loseResponse = false;
        throw new Error('contained accepted response loss');
      }
      return Response.json({ submission_id: body.submission_id });
    });
    expect(await send()).toMatchObject({ queued: true, submission_id: id });
    await drainFeedback('http://127.0.0.1/contained-feedback', profile);
    expect(stored.size).toBe(1);
    expect(rows()).toEqual([]);
  });

  it('holds an unconfirmed receipt and refuses an altered payload under the same key', async () => {
    transport(async () => Response.json({ ok: true }));
    expect(await send()).toMatchObject({ queued: false, error: 'delivery_unconfirmed' });
    expect(rows()[0].queue_state).toBe('held');
    expect(
      await submitFeedback(
        { message: 'harmless altered draft', submission_id: id },
        'http://127.0.0.1/contained-feedback',
        profile,
        () => 'synthetic-install'
      )
    ).toMatchObject({ success: false, error: 'submission_conflict' });
  });
});

describe('feedback body-free receipt contract', () => {
  const origin = {
    consentScope: '33690000-0000-4000-8000-000000000010',
    contextId: '55700000-0000-4000-8000-000000000031',
    metricId: '33690000-0000-4000-8000-000000000011',
    processId: '33690000-0000-4000-8000-000000000012',
    classification: 'synthetic' as const,
  };
  it('reports honest native stages but never passes body or private nonces to the HTTP transport', async () => {
    const record = vi.fn();
    configureFeedbackTelemetry({ captureOrigin: () => origin, record });
    const fetch = transport(async () => {
      throw new Error('contained offline');
    });
    expect(await send()).toMatchObject({ queued: true });
    expect(record.mock.calls.map(([receipt]) => receipt.stage)).toEqual([
      'accepted_intent',
      'durable_queue',
      'deferred',
    ]);
    expect(JSON.stringify(record.mock.calls)).not.toContain('harmless durable decoy');
    const post = fetch.mock.calls.find(([, options]) => options.method === 'POST');
    expect(String(post?.[1].body)).not.toContain(origin.consentScope);
    expect(String(post?.[1].body)).not.toContain(origin.metricId);
    expect(String(post?.[1].body)).not.toContain(origin.contextId);
    expect(String(post?.[1].body)).not.toContain('queue_state');
    const originalClock = record.mock.calls[0][0].originalAtMs;
    transport(async (body) => Response.json({ submission_id: body.submission_id }));
    await drainFeedback('http://127.0.0.1/contained-feedback', profile);
    expect(record.mock.calls.at(-1)?.[0]).toMatchObject({
      stage: 'backend_accepted',
      operationId: id,
      originalAtMs: originalClock,
      attempt: 2,
    });
  });
  it('does not attach a later opt-in to a submission whose origin was not authorized', async () => {
    configureFeedbackTelemetry({ captureOrigin: () => null, record: vi.fn() });
    transport(async () => {
      throw new Error('contained offline');
    });
    await send();
    const record = vi.fn();
    configureFeedbackTelemetry({ captureOrigin: () => origin, record });
    transport(async (body) => Response.json({ submission_id: body.submission_id }));
    await drainFeedback('http://127.0.0.1/contained-feedback', profile);
    expect(record).not.toHaveBeenCalled();
    expect(rows()).toEqual([]);
  });
  it('keeps legacy origin metadata local and never replaces it with the delivery context', async () => {
    configureFeedbackTelemetry({ captureOrigin: () => origin, record: vi.fn() });
    transport(async () => {
      throw new Error('contained offline');
    });
    await send();
    const saved = JSON.parse(fs.readFileSync(join(profile, 'pending-feedback.json'), 'utf8'));
    delete saved[0].telemetry.contextId;
    fs.writeFileSync(join(profile, 'pending-feedback.json'), JSON.stringify(saved));
    const captureOrigin = vi.fn(() => origin);
    const record = vi.fn();
    configureFeedbackTelemetry({ captureOrigin, record });
    const wire = transport(async (body) => Response.json({ submission_id: body.submission_id }));
    await drainFeedback('http://127.0.0.1/contained-feedback', profile);
    expect(captureOrigin).not.toHaveBeenCalled();
    expect(rows()).toEqual([]);
    expect(record.mock.calls.at(-1)?.[0].origin.contextId).toBeUndefined();
    expect(JSON.stringify(wire.mock.calls)).not.toContain(origin.contextId);
  });
});

it('does not let optional metrics exceptions change feedback delivery', async () => {
  const record = vi.fn(() => {
    throw new Error('optional metrics unavailable');
  });
  configureFeedbackTelemetry({
    captureOrigin: () => {
      throw new Error('optional origin unavailable');
    },
    record,
  });
  transport(async (body) => Response.json({ submission_id: body.submission_id }));
  expect(await send()).toMatchObject({ success: true });
  expect(record).not.toHaveBeenCalled();
});

describe('committed feedback receipt recovery', () => {
  const originalOrigin = {
    consentScope: '57300000-0000-4000-8000-000000000001',
    contextId: '57300000-0000-4000-8000-000000000002',
    metricId: '57300000-0000-4000-8000-000000000003',
    processId: '57300000-0000-4000-8000-000000000004',
    classification: 'private' as const,
  };
  it('replays committed original queue stages after a real module restart without recapturing origin or clocks', async () => {
    const observed: FeedbackReceipt[] = [];
    configureFeedbackTelemetry({
      captureOrigin: () => originalOrigin,
      record: (receipt) => {
        observed.push(structuredClone(receipt));
        return false;
      },
    });
    transport(async () => {
      throw new Error('contained offline');
    });
    expect(await send()).toMatchObject({ success: false, queued: true });
    const originalStages = ['accepted_intent', 'durable_queue'].map(
      (stage) => observed.find((receipt) => receipt.stage === stage)!
    );
    expect(originalStages.every(Boolean)).toBe(true);
    vi.resetModules();
    const restarted = await import('./feedback-queue');
    const recapture = vi.fn(() => ({
      ...originalOrigin,
      processId: '57300000-0000-4000-8000-000000000005',
    }));
    const repaired: FeedbackReceipt[] = [];
    restarted.configureFeedbackTelemetry({
      captureOrigin: recapture,
      record: (receipt: FeedbackReceipt, readCommitted?: () => FeedbackReceipt | null) => {
        expect(readCommitted).toBeTypeOf('function');
        expect(readCommitted!()).toEqual(receipt);
        repaired.push(structuredClone(receipt));
        return true;
      },
    });
    transport(async (body) => Response.json({ submission_id: body.submission_id }));
    try {
      await restarted.drainFeedback('http://127.0.0.1/contained-feedback', profile);
      for (const receipt of originalStages) expect(repaired).toContainEqual(receipt);
      expect(
        repaired.every(
          (receipt) => JSON.stringify(receipt.origin) === JSON.stringify(originalOrigin)
        )
      ).toBe(true);
      expect(recapture).not.toHaveBeenCalled();
      expect(rows()).toEqual([]);
    } finally {
      restarted.configureFeedbackTelemetry(null);
    }
  });
  it('keeps a body-free committed terminal receipt when global admission fails and repairs it without another POST', async () => {
    const observed: FeedbackReceipt[] = [];
    configureFeedbackTelemetry({
      captureOrigin: () => originalOrigin,
      record: (receipt) => {
        observed.push(structuredClone(receipt));
        return false;
      },
    });
    const fetch = transport(async (body) => Response.json({ submission_id: body.submission_id }));
    expect(await send()).toMatchObject({ success: true });
    const terminal = observed.find((receipt) => receipt.stage === 'backend_accepted')!;
    expect(terminal).toBeDefined();
    expect(cancelFeedback(profile, id)).toMatchObject({ success: true, submission_id: id });
    expect(observed.some((receipt) => receipt.stage === 'cancelled')).toBe(false);
    expect(fs.readFileSync(join(profile, 'pending-feedback.json'), 'utf8')).not.toContain(
      'harmless durable decoy'
    );
    const posts = fetch.mock.calls.filter(([, options]) => options.method === 'POST').length;
    vi.resetModules();
    const restarted = await import('./feedback-queue');
    const recapture = vi.fn(() => ({
      ...originalOrigin,
      metricId: '57300000-0000-4000-8000-000000000006',
    }));
    const repaired: FeedbackReceipt[] = [];
    restarted.configureFeedbackTelemetry({
      captureOrigin: recapture,
      record: (receipt: FeedbackReceipt, readCommitted?: () => FeedbackReceipt | null) => {
        expect(readCommitted).toBeTypeOf('function');
        expect(readCommitted!()).toEqual(receipt);
        repaired.push(structuredClone(receipt));
        return true;
      },
    });
    try {
      await restarted.drainFeedback('http://127.0.0.1/contained-feedback', profile);
      expect(repaired).toContainEqual(terminal);
      expect(fetch.mock.calls.filter(([, options]) => options.method === 'POST')).toHaveLength(
        posts
      );
      expect(recapture).not.toHaveBeenCalled();
      expect(rows()).toEqual([]);
    } finally {
      restarted.configureFeedbackTelemetry(null);
    }
  });
  it('context-ready receipt recovery never retries a pending private product POST', async () => {
    configureFeedbackTelemetry({ captureOrigin: () => originalOrigin, record: () => false });
    const fetch = transport(async () => {
      throw new Error('contained offline');
    });
    expect(await send()).toMatchObject({ success: false, queued: true });
    const saved = JSON.parse(fs.readFileSync(join(profile, 'pending-feedback.json'), 'utf8'))[0];
    const received: FeedbackReceipt[] = [];
    configureFeedbackTelemetry({
      captureOrigin: () => {
        throw new Error('receipt replay cannot recapture an origin');
      },
      record: (receipt, readCommitted) => {
        expect(readCommitted?.()).toEqual(receipt);
        received.push(receipt);
        return true;
      },
    });
    fetch.mockClear();
    replayFeedbackTelemetry(profile);
    expect(fetch).not.toHaveBeenCalled();
    expect(received.map((receipt) => receipt.stage)).toEqual([
      'accepted_intent',
      'durable_queue',
      'deferred',
    ]);
    const remaining = JSON.parse(
      fs.readFileSync(join(profile, 'pending-feedback.json'), 'utf8')
    )[0];
    expect(remaining).toMatchObject({
      message: saved.message,
      queue_state: saved.queue_state,
      attempt_count: saved.attempt_count,
    });
    expect(remaining.telemetry_receipts).toEqual([]);
  });
  it('does not count body-free completed receipt cache entries against live product capacity', async () => {
    configureFeedbackTelemetry({ captureOrigin: () => originalOrigin, record: () => false });
    transport(async (body) => Response.json({ submission_id: body.submission_id }));
    expect(await send()).toMatchObject({ success: true });
    const saved = JSON.parse(fs.readFileSync(join(profile, 'pending-feedback.json'), 'utf8'))[0];
    expect(saved.message).toBe('');
    const cache = Array.from({ length: 50 }, (_, n) => ({
      ...saved,
      submission_id: `57300000-0000-4000-8000-${String(n + 100).padStart(12, '0')}`,
    }));
    fs.writeFileSync(join(profile, 'pending-feedback.json'), JSON.stringify(cache));
    transport(async () => {
      throw new Error('contained offline');
    });
    expect(
      await submitFeedback(
        { message: 'harmless new pending decoy', submission_id: id },
        'http://127.0.0.1/contained-feedback',
        profile,
        () => 'synthetic-install'
      )
    ).toMatchObject({ success: false, queued: true });
    expect(rows().filter((row) => row.message === 'harmless new pending decoy')).toHaveLength(1);
    expect(rows().filter((row) => row.message === '')).toHaveLength(50);
  });
  it('does not treat a void optional offer as durable admission or retain accepted body bytes', async () => {
    configureFeedbackTelemetry({ captureOrigin: () => originalOrigin, record: vi.fn() });
    const fetch = transport(async (body) => Response.json({ submission_id: body.submission_id }));
    expect(await send()).toMatchObject({ success: true });
    const saved = JSON.parse(fs.readFileSync(join(profile, 'pending-feedback.json'), 'utf8'))[0];
    expect(saved.message).toBe('');
    expect(saved.telemetry_receipts).toHaveLength(3);
    const encodedWire = JSON.stringify(fetch.mock.calls);
    for (const field of ['telemetry_receipts', 'payload_digest', 'backend_accepted_at_ms']) {
      expect(encodedWire).not.toContain(field);
    }
    expect(encodedWire).not.toContain(saved.payload_digest);
  });
  it('projects only receipt fields and never accepts embedded identity or original-clock overrides from optional metadata', async () => {
    configureFeedbackTelemetry({ captureOrigin: () => originalOrigin, record: () => false });
    transport(async () => {
      throw new Error('contained offline');
    });
    await send();
    const saved = JSON.parse(fs.readFileSync(join(profile, 'pending-feedback.json'), 'utf8'));
    Object.assign(saved[0].telemetry_receipts[0], {
      message: 'harmless injected receipt decoy',
      operationId: '57300000-0000-4000-8000-000000000099',
      originalAtMs: 1,
      origin: { ...originalOrigin, metricId: '57300000-0000-4000-8000-000000000098' },
    });
    fs.writeFileSync(join(profile, 'pending-feedback.json'), JSON.stringify(saved));
    const received: FeedbackReceipt[] = [];
    configureFeedbackTelemetry({
      captureOrigin: () => originalOrigin,
      record: (receipt) => {
        received.push(structuredClone(receipt));
        return true;
      },
    });
    transport(async (body) => Response.json({ submission_id: body.submission_id }));
    await drainFeedback('http://127.0.0.1/contained-feedback', profile);
    expect(received.find((receipt) => receipt.stage === 'accepted_intent')).toMatchObject({
      origin: originalOrigin,
      operationId: id,
      originalAtMs: Date.parse(saved[0].timestamp),
    });
    expect(JSON.stringify(received)).not.toContain('harmless injected receipt decoy');
    expect(rows()).toEqual([]);
  });
});
