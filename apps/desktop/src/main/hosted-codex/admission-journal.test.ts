import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import {
  appendHostedCodexAdmissionJournal,
  appendHostedCodexRouteAvailabilityJournal,
  HOSTED_CODEX_ADMISSION_JOURNAL_FILE,
} from './admission-journal';

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('Hosted Codex admission journal', () => {
  it('records a main-owned denial without credentials or prompts', async () => {
    const root = mkdtempSync(join(tmpdir(), 'hosted-codex-admission-'));
    roots.push(root);
    const record = await appendHostedCodexAdmissionJournal({
      userDataRoot: root,
      recordedAt: new Date('2026-08-21T12:00:00.000Z'),
      identity: { workflowId: 'workflow-1', runId: 'run-1', turnId: 'turn-1' },
      result: { ok: false, code: 'signed_out', message: 'not persisted' },
    });
    expect(record).toMatchObject({ admitted: false, decisionCode: 'signed_out' });
    const raw = readFileSync(join(root, 'logs', HOSTED_CODEX_ADMISSION_JOURNAL_FILE), 'utf8');
    expect(raw).not.toContain('not persisted');
    expect(JSON.parse(raw.trim())).toEqual(record);
  });

  it('records a main-owned route denial without the access token', async () => {
    const root = mkdtempSync(join(tmpdir(), 'hosted-codex-availability-'));
    roots.push(root);
    const record = await appendHostedCodexRouteAvailabilityJournal({
      userDataRoot: root,
      result: {
        ok: false,
        code: 'not_configured',
        message: 'not persisted',
        gatewayOrigin: null,
      },
    });
    expect(record).toMatchObject({
      available: false,
      decisionCode: 'not_configured',
      gatewayOrigin: null,
    });
  });

  it('records a server-owned unavailable reason and public gateway origin', async () => {
    const root = mkdtempSync(join(tmpdir(), 'hosted-codex-availability-'));
    roots.push(root);
    const record = await appendHostedCodexRouteAvailabilityJournal({
      userDataRoot: root,
      result: {
        ok: true,
        available: false,
        reason: 'provider_unavailable',
        gatewayOrigin: 'https://gateway.example',
      },
    });
    expect(record).toMatchObject({
      available: false,
      decisionCode: 'provider_unavailable',
      gatewayOrigin: 'https://gateway.example',
    });
  });
});
