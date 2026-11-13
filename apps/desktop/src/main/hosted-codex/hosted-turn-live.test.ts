import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import type { HostedStreamEvent } from '@waypoint/hosted-ai-contract';
import {
  HOSTED_NATIVE_TOOL_DEFINITIONS,
  HOSTED_TOOL_TRANSPORT_DEFINITIONS,
} from '@waypoint/hosted-ai-contract';
import { createTestDb } from '../__tests__/test-db';
import { createAgentStateCapsuleTable, AgentStateCapsuleStore } from './agent-state-capsule';
import { resolveCodexAppServerBinary } from './app-server-binary';
import { createHostedCodexGatewayWorkflow } from './hosted-gateway-workflow';
import { startHostedSession, type HostedSession } from './hosted-session';

const IS_DARWIN_ARM64 = process.platform === 'darwin' && process.arch === 'arm64';
const RESERVATION = '5d0f9e18-5f0a-4d9c-9e0e-0f2a2c3b4d5e';

describe.skipIf(!IS_DARWIN_ARM64)('a real Hosted turn', () => {
  let session: HostedSession | null = null;
  let root = '';

  afterEach(async () => {
    await session?.close();
    session = null;
    if (root) rmSync(root, { recursive: true, force: true });
    root = '';
  });

  function reply(text: string): () => AsyncIterable<HostedStreamEvent> {
    return () =>
      (async function* (): AsyncGenerator<HostedStreamEvent> {
        const base = { v: 2 as const, requestId: 'r', runId: 'run', turnId: 't', stepSequence: 1 };
        yield {
          ...base,
          seq: 1,
          event: 'accepted',
          reservationId: RESERVATION,
          tier: 'auto',
          catalogVersion: '1.0.0',
          rateCardVersion: '1.0.0',
        };
        yield { ...base, seq: 2, event: 'text_delta', delta: text };
        yield {
          ...base,
          seq: 3,
          event: 'finish',
          reservationId: RESERVATION,
          usageEventId: null,
          outcome: 'completed',
          usage: {
            status: 'reported',
            inputTokens: 1,
            outputTokens: 1,
            cacheReadTokens: null,
            cacheWriteTokens: null,
            reasoningTokens: null,
          },
          finishReason: { unified: 'stop', raw: 'stop' },
          workflowTrace: null,
          researchContributionNotice: null,
        };
      })();
  }

  it('runs from turn/start to turn/completed through the gateway', async () => {
    const seenTools: string[][] = [];
    const seenRequests: {
      instructions: string | undefined;
      promptCacheKey: string | undefined;
      forwarded: Record<string, unknown>;
    }[] = [];
    let steps = 0;

    root = mkdtempSync(path.join(os.tmpdir(), 'hosted-turn-'));
    const db = createTestDb();
    createAgentStateCapsuleTable(db);
    const capsules = new AgentStateCapsuleStore(db);
    session = await startHostedSession({
      binary: resolveCodexAppServerBinary(),
      rootDir: root,
      runId: 'live-turn',
      model: 'gpt-5-codex',
      store: capsules,
      handshakeTimeoutMs: 30_000,
      requestTimeoutMs: 30_000,
      step: ((accepted: {
        toolNames: readonly string[];
        instructions: string | undefined;
        promptCacheKey: string | undefined;
        forwarded: Record<string, unknown>;
      }) => {
        steps += 1;
        seenTools.push([...accepted.toolNames]);
        seenRequests.push({
          instructions: accepted.instructions,
          promptCacheKey: accepted.promptCacheKey,
          forwarded: accepted.forwarded,
        });
        return reply('hello from the gateway')();
      }) as never,
    });

    const result = await session.runTurn({
      message: 'say hello',
      execute: async () => {
        throw new Error('the text-only model step unexpectedly called a tool');
      },
      approve: async () => 'approved',
      idleTimeoutMs: 60_000,
    });

    expect(result).toEqual({ outcome: 'completed', text: 'hello from the gateway' });
    expect(session.appServer.supervisor.isTerminated).toBe(false);

    expect(steps).toBe(1);
    expect(capsules.readActive('live-turn')?.budget.providerAttempts).toBe(1);

    const [firstRequest] = seenRequests;
    expect(firstRequest.instructions ?? '').toContain('DNAForge Hosted');
    expect((firstRequest.instructions ?? '').length).toBeGreaterThan(100);
    expect(firstRequest.promptCacheKey ?? '').toMatch(/^[0-9a-f-]{36}$/u);

    expect(firstRequest.forwarded).not.toHaveProperty('client_metadata');
    expect(JSON.stringify(firstRequest.forwarded)).not.toContain('installation_id');

    const nativeNames = new Set<string>(HOSTED_NATIVE_TOOL_DEFINITIONS.map((tool) => tool.name));
    expect(session.catalog.tools.some((tool) => !nativeNames.has(tool.name))).toBe(true);
    expect(seenTools[0]).toEqual([
      ...HOSTED_TOOL_TRANSPORT_DEFINITIONS.map((tool) => tool.name),
      ...session.catalog.tools
        .filter((tool) => nativeNames.has(tool.name))
        .map((tool) => tool.name),
      'request_user_input',
    ]);
    expect(session.catalog.tools.map((tool) => tool.name)).toContain('get_workspace');
  }, 180_000);

  it('admits the full production tool catalog through the Hosted request contract', async () => {
    root = mkdtempSync(path.join(os.tmpdir(), 'hosted-full-catalog-'));
    const db = createTestDb();
    createAgentStateCapsuleTable(db);
    const workflow = createHostedCodexGatewayWorkflow({
      identity: { workflowId: 'workflow', runId: 'full-catalog', turnId: 'turn' },
      tier: 'auto',
      gatewayOrigin: 'https://example.test',
      turnBindingToken: 'binding',
      workspaceOpen: true,
      stagedReferenceIds: [],
      stream: () => reply('hello from the gateway')(),
      callLocalTool: async () => {
        throw new Error('unexpected tool call');
      },
      requestUserApproval: async () => false,
      recordObservation: async () => {
        throw new Error('unexpected observation');
      },
      claimTool: async () => {
        throw new Error('unexpected claim');
      },
      completeToolClaim: async () => {
        throw new Error('unexpected completion');
      },
      cancelToolClaim: async () => {
        throw new Error('unexpected cancellation');
      },
    });
    session = await startHostedSession({
      binary: resolveCodexAppServerBinary(),
      rootDir: root,
      runId: 'full-catalog',
      model: 'gpt-5-codex',
      store: new AgentStateCapsuleStore(db),
      allowEffects: ['read-only', 'ui-bound', 'mutating'],
      step: workflow.step,
    });
    const result = await session.runTurn({
      message: 'Design an E. coli pAraBAD-inducible MBP expression backbone',
      execute: async () => {
        throw new Error('unexpected tool call');
      },
      approve: async () => 'declined',
      idleTimeoutMs: 60_000,
    });
    expect(result).toEqual({ outcome: 'completed', text: 'hello from the gateway' });
  }, 180_000);
});
