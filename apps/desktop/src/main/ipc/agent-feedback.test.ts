import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { sendAgentFeedback } from './agent-feedback';

let profile: string;
const report = {
  observationId: '1ec40674-bf18-4d5b-a837-73505421bc8a',
  kind: 'bug' as const,
  summary: 'App action fails',
  description: 'Observed a failed action.',
  expected: 'The action succeeds.',
  actual: 'The action returns an error.',
};
beforeEach(() => {
  profile = mkdtempSync(join(tmpdir(), 'agent-feedback-'));
});
afterEach(() => {
  vi.unstubAllGlobals();
  rmSync(profile, { recursive: true, force: true });
});

describe('agent report delivery', () => {
  it('uses one report ID on retry and adds only main-owned app context', async () => {
    const bodies: Record<string, string>[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn<typeof fetch>(async (_url, init) => {
        if (typeof init?.body !== 'string') throw new Error('Expected a JSON report body.');
        const body = JSON.parse(init.body);
        bodies.push(body);
        return Response.json({ ok: true, report_id: body.report_id }, { status: 201 });
      })
    );
    const first = await sendAgentFeedback(report, 'http://127.0.0.1/feedback', profile, '1.2.3');
    const second = await sendAgentFeedback(report, 'http://127.0.0.1/feedback', profile, '1.2.3');
    expect(first).toMatchObject({ ok: true, reportId: bodies[0].report_id });
    expect(second).toMatchObject({ ok: true, reportId: bodies[0].report_id });
    expect(bodies[0]).toMatchObject({ app_version: '1.2.3', user_agent: 'DNAForge/1.2.3 Agent' });
    expect(bodies[0].message).toContain('[Agent bug report]');
    expect(bodies[0].platform_info).toBe(`${process.platform} ${process.arch}`);
    expect(Object.keys(bodies[0]).sort()).toEqual([
      'app_version',
      'install_id',
      'message',
      'platform_info',
      'report_id',
      'user_agent',
    ]);
  });
  it('records a new observation even when its evidence is identical across versions', async () => {
    const bodies: Record<string, string>[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn<typeof fetch>(async (_url, init) => {
        if (typeof init?.body !== 'string') throw new Error('Expected a JSON report body.');
        const body = JSON.parse(init.body);
        bodies.push(body);
        return Response.json({ ok: true, report_id: body.report_id });
      })
    );
    await sendAgentFeedback(report, 'http://localhost/feedback', profile, '1.2.3');
    await sendAgentFeedback(
      { ...report, observationId: '2ec40674-bf18-4d5b-a837-73505421bc8a' },
      'http://localhost/feedback',
      profile,
      '1.2.4'
    );
    expect(bodies).toHaveLength(2);
    expect(bodies[1].report_id).not.toBe(bodies[0].report_id);
  });
  it.each([{ ok: true }, { ok: true, report_id: 'wrong-id' }, 'not-json'])(
    'does not automatically retry an unrecognized successful receipt %j',
    async (receipt) => {
      vi.stubGlobal(
        'fetch',
        vi
          .fn()
          .mockResolvedValue(
            typeof receipt === 'string' ? new Response(receipt) : Response.json(receipt)
          )
      );
      expect(
        await sendAgentFeedback(report, 'http://localhost/feedback', profile, '1')
      ).toMatchObject({
        ok: false,
        code: 'FEEDBACK_RECEIPT_INVALID',
        retriable: false,
        stateChanged: 'unknown',
      });
    }
  );
  it('returns rate limiting with the retry delay, without claiming submission', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(new Response('', { status: 429, headers: { 'Retry-After': '60' } }))
    );
    expect(
      await sendAgentFeedback(report, 'http://localhost/feedback', profile, '1')
    ).toMatchObject({
      ok: false,
      code: 'FEEDBACK_RATE_LIMITED',
      stateChanged: false,
      retriable: true,
      details: { retryAfterSeconds: 60 },
    });
  });
  it('preserves an uncertain network outcome and never queues an unconfirmed report', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('offline')));
    expect(
      await sendAgentFeedback(report, 'http://localhost/feedback', profile, '1')
    ).toMatchObject({
      ok: false,
      code: 'FEEDBACK_DELIVERY_FAILED',
      retriable: true,
      stateChanged: 'unknown',
    });
  });
});
