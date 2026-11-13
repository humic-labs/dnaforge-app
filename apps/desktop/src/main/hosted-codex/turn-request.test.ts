import { describe, expect, it } from 'vitest';
import { MAX_HOSTED_WHOLE_REQUEST_BYTES } from '@waypoint/hosted-ai-contract';

import { parseHostedCodexTurnStartRequest } from './turn-request';

function request(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    workflowId: 'workflow-1',
    runId: 'run-1',
    turnId: 'turn-1',
    tier: 'auto',
    developerInstructions: 'Use only the offered DNAForge tools.',
    userMessage: 'Reply with exactly pineapple.',
    priorConversationContext: null,
    workspaceOpen: false,
    stagedReferenceIds: [],
    ...overrides,
  };
}

describe('parseHostedCodexTurnStartRequest', () => {
  it('accepts only the closed authority-separated turn shape', () => {
    expect(parseHostedCodexTurnStartRequest(request())).toEqual(request());
    expect(
      parseHostedCodexTurnStartRequest(request({ prompt: 'flattened legacy prompt' }))
    ).toBeNull();
    expect(parseHostedCodexTurnStartRequest(request({ developerInstructions: ' ' }))).toBeNull();
    expect(parseHostedCodexTurnStartRequest(request({ userMessage: '' }))).toBeNull();
    expect(parseHostedCodexTurnStartRequest(request({ priorConversationContext: [] }))).toBeNull();
  });

  it('accepts well-formed permission words and rejects malformed ones', () => {
    const permissions = { codex: ':danger-full-access' };
    expect(parseHostedCodexTurnStartRequest(request({ permissions }))).toEqual(
      request({ permissions })
    );
    expect(
      parseHostedCodexTurnStartRequest(request({ permissions: { codex: '--yolo' } }))
    ).toBeNull();
  });

  it('rejects a combined turn envelope above the byte limit', () => {
    const baselineBytes = Buffer.byteLength(
      JSON.stringify(request({ priorConversationContext: '' })),
      'utf8'
    );
    expect(
      parseHostedCodexTurnStartRequest(
        request({
          priorConversationContext: 'x'.repeat(MAX_HOSTED_WHOLE_REQUEST_BYTES - baselineBytes + 1),
        })
      )
    ).toBeNull();
  });
});
