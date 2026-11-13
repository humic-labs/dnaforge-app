import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { hostedCodexStoppedAnswer } from '../../shared/hosted-codex-stopped-answer';

import {
  appendHostedCodexTurnJournal,
  HOSTED_CODEX_TURN_JOURNAL_FILE,
  hostedCodexAnswerSha256,
} from './turn-journal';
import {
  observeHostedToolInventory,
  type HostedToolInventoryCounts,
} from './tool-inventory-observation';

const inventoryCounts: HostedToolInventoryCounts = {
  projectionSequence: 0,
  authorizationCatalogDefinitionCount: 300,
  registeredChildDefinitionCount: 17,
  childOfferedDefinitionCount: 17,
  gatewayBaseDefinitionCount: 16,
  gatewayForwardedDefinitionCount: 24,
  retainedDefinitionCount: 8,
  maxRetainedDefinitionCount: 8,
  acceptedDiscoveryPageCount: 1,
  lastAcceptedDiscoveryPageDefinitionCount: 8,
  maxAcceptedDiscoveryPageDefinitionCount: 8,
};

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('Hosted Codex turn journal', () => {
  it('persists exact artifact and gateway provenance without transcript contents', async () => {
    const root = mkdtempSync(join(tmpdir(), 'hosted-codex-journal-'));
    roots.push(root);
    const prompt = 'PRIVATE PROMPT SENTINEL';
    const answer = 'PRIVATE ANSWER SENTINEL';
    const inventoryWithExtra = {
      ...observeHostedToolInventory(0, inventoryCounts),
      prompt: 'PRIVATE INVENTORY SENTINEL',
      tools: [{ name: 'PRIVATE INVENTORY TOOL' }],
    };
    const summaryWithExtra = {
      status: 'observed' as const,
      projectionCount: 1,
      authorizationCatalogDefinitionCount: 300,
      registeredChildDefinitionCount: 17,
      retainedDefinitionCount: 8,
      maxRetainedDefinitionCount: 8,
      acceptedDiscoveryPageCount: 1,
      lastAcceptedDiscoveryPageDefinitionCount: 8,
      maxAcceptedDiscoveryPageDefinitionCount: 8,
      arguments: 'PRIVATE INVENTORY SENTINEL',
    };
    const record = await appendHostedCodexTurnJournal({
      userDataRoot: root,
      recordedAt: new Date('2026-08-20T12:34:56.000Z'),
      identity: { workflowId: 'workflow-1', runId: 'run-1', turnId: 'turn-1' },
      gateway: {
        gatewayOrigin: 'https://hosted.dnaforge.com',
        catalogVersion: 'catalog-7',
        rateCardVersion: 'rates-4',
        reservationIds: ['reservation-1'],
        usageEventIds: ['usage-1'],
        workflowRunId: 'gateway-run-1',
        workflowStepId: 'gateway-step-2',
        completedToolCallIds: ['tool-call-1'],
        providerAttempts: 1,
        terminalError: null,
      },
      artifact: {
        desktopSourceCommit: 'c'.repeat(40),
        appServerVersion: '0.105.0',
        appServerSha256: 'a'.repeat(64),
        appServerTarget: 'aarch64-apple-darwin',
      },
      transport: {
        toolInventorySummary: summaryWithExtra,
        requestSizes: [
          {
            requestSequence: 0,
            phase: 'initial',
            measuredBytes: 276_383,
            warningBytes: 1_572_864,
            maximumBytes: 2_097_152,
            threshold: 'normal',
            disposition: 'accepted',
            gatewayAttempted: true,
          },
        ],
        responseStreams: [
          {
            responseSequence: 0,
            requestSequence: 0,
            toolInventory: inventoryWithExtra,
            gatewayEventTotal: 1,
            gatewayEvents: [
              {
                type: 'text_delta',
                fields: { delta: { type: 'string', utf8Bytes: Buffer.byteLength(answer) } },
              },
            ],
            responsesEventTotal: 1,
            responsesEvents: [
              {
                type: 'response.output_text.delta',
                fields: { delta: { type: 'string', utf8Bytes: Buffer.byteLength(answer) } },
              },
            ],
            outcome: 'completed',
            errorCode: null,
            responseDigest: 'e'.repeat(64),
          },
        ],
        childFailure: null,
      },
      outcome: 'completed',
      answer,
    });

    expect(record.answerSha256).toBe(hostedCodexAnswerSha256(answer));
    expect(record).not.toHaveProperty('prompt');
    expect(record).not.toHaveProperty('answer');
    expect(record.gateway).not.toHaveProperty('provider');
    expect(record.gateway).not.toHaveProperty('model');
    expect(record.transport.responseStreams[0].toolInventory).toEqual(
      observeHostedToolInventory(0, inventoryCounts)
    );
    expect(record.transport.toolInventorySummary).toMatchObject({
      status: 'observed',
      projectionCount: 1,
    });
    const path = join(root, 'logs', HOSTED_CODEX_TURN_JOURNAL_FILE);
    const raw = readFileSync(path, 'utf8');
    expect(raw).not.toContain(prompt);
    expect(raw).not.toContain(answer);
    expect(raw).not.toContain('PRIVATE INVENTORY');
    expect(JSON.parse(raw.trim())).toEqual(record);
    expect(statSync(path).mode & 0o077).toBe(0);
  });

  it('appends one newline-delimited receipt per terminal turn', async () => {
    const root = mkdtempSync(join(tmpdir(), 'hosted-codex-journal-'));
    roots.push(root);
    const base = {
      userDataRoot: root,
      identity: { workflowId: 'workflow-1', runId: 'run-1', turnId: 'turn-1' },
      gateway: {
        gatewayOrigin: 'https://hosted.dnaforge.com',
        catalogVersion: null,
        rateCardVersion: null,
        reservationIds: [],
        usageEventIds: [],
        workflowRunId: null,
        workflowStepId: null,
        completedToolCallIds: [],
        providerAttempts: 0,
        terminalError: null,
      },
      artifact: {
        desktopSourceCommit: 'd'.repeat(40),
        appServerVersion: '0.105.0',
        appServerSha256: 'b'.repeat(64),
        appServerTarget: 'x86_64-pc-windows-msvc',
      },
      transport: { requestSizes: [], responseStreams: [], childFailure: null },
      answer: '',
    } as const;
    await appendHostedCodexTurnJournal({ ...base, outcome: 'stopped' });
    await appendHostedCodexTurnJournal({
      ...base,
      identity: { ...base.identity, turnId: 'turn-2' },
      outcome: 'outcome_unknown',
    });

    const lines = readFileSync(join(root, 'logs', HOSTED_CODEX_TURN_JOURNAL_FILE), 'utf8')
      .trim()
      .split('\n');
    expect(lines).toHaveLength(2);
    expect(lines.map((line) => JSON.parse(line).outcome)).toEqual(['stopped', 'outcome_unknown']);
    expect(JSON.parse(lines[0]!).answerSha256).toBe(
      hostedCodexAnswerSha256(hostedCodexStoppedAnswer(''))
    );
    expect(JSON.parse(lines[1]!).answerSha256).toBe(hostedCodexAnswerSha256(''));
  });
});
