import { describe, expect, it, vi } from 'vitest';
import type { ChatMessage } from './chat-types';
import {
  collectCreatedArtifactClaims,
  prepareAgentArtifactDelivery,
  sanitizeAssistantArtifactMetadata,
} from './artifact-delivery';

const DESIGN_ID = 'e8dd4c82-1d86-4149-9946-487c41d00ad7';
const DOCUMENT_ID = '479b4be5-4ab4-4777-8170-72ab7bb640c6';

function message(role: ChatMessage['role'], content: string, toolName?: string): ChatMessage {
  return { id: crypto.randomUUID(), role, content, toolName, createdAt: 1 };
}

it('takes artifact identities only from successful DNAForge tool results', () => {
  const activity = message(
    'activity',
    JSON.stringify({
      type: 'agent.activity',
      version: 1,
      event: {
        toolCalls: [
          {
            name: 'create_design',
            mcpServer: 'dnaforge',
            status: 'completed',
            output: {
              structuredContent: {
                ok: true,
                result: { designId: DESIGN_ID, name: 'Example draft' },
              },
            },
          },
          {
            name: 'import_sequence',
            mcpServer: 'dnaforge',
            status: 'completed',
            output: {
              structuredContent: {
                ok: true,
                result: { imported: true, documentId: DOCUMENT_ID, name: 'Example source' },
              },
            },
          },
          {
            name: 'create_design',
            mcpServer: 'other',
            status: 'completed',
            output: { designId: crypto.randomUUID(), name: 'Untrusted' },
          },
        ],
      },
    })
  );
  const assistant = message('assistant', `Design ID: ${DESIGN_ID}`);

  expect(collectCreatedArtifactClaims([activity, assistant])).toEqual([
    { kind: 'design', id: DESIGN_ID, label: 'Example draft' },
    { kind: 'sequence', id: DOCUMENT_ID, label: 'Example source' },
  ]);
});

it('collects literal sequence products only with a matching accepted revision', () => {
  const resourceRevisionId = `rr_${'a'.repeat(64)}`;
  const output = {
    saved: true,
    documentId: DOCUMENT_ID,
    name: 'Test fragment',
    acceptedRevision: {
      kind: 'accepted-object',
      resourceId: DOCUMENT_ID,
      resourceRevisionId,
    },
  };
  const receipt = (payload: object) =>
    message(
      'tool',
      JSON.stringify({ output: { structuredContent: { ok: true, result: payload } } }),
      'create_sequence_product'
    );
  expect(collectCreatedArtifactClaims([receipt(output)])).toEqual([
    {
      kind: 'sequence',
      id: DOCUMENT_ID,
      label: 'Test fragment',
      acceptedSequenceRevisionId: resourceRevisionId,
    },
  ]);
  expect(
    collectCreatedArtifactClaims([
      receipt({
        ...output,
        acceptedRevision: { ...output.acceptedRevision, resourceId: DESIGN_ID },
      }),
      receipt({ ...output, saved: false }),
    ])
  ).toEqual([]);
});

describe('prepareAgentArtifactDelivery', () => {
  it('creates openable design and sequence references only for saved files', async () => {
    const claims = [
      { kind: 'design' as const, id: DESIGN_ID, label: 'Example draft' },
      { kind: 'sequence' as const, id: DOCUMENT_ID, label: 'Example source' },
    ];
    const resolveSavedArtifact = vi.fn(async () => ({
      path: '/project/saved-artifact',
      workspaceRoot: '/project',
    }));

    const result = await prepareAgentArtifactDelivery(claims, { resolveSavedArtifact });

    expect(result.failedClaims).toEqual([]);
    expect(result.references).toEqual([
      expect.objectContaining({
        entity_type: 'assembly',
        source: 'ai',
        display_label: 'Example draft',
        locator: `entity://assembly/${DESIGN_ID}`,
        workspace_root_path: '/project',
      }),
      expect.objectContaining({
        entity_type: 'sequence',
        display_label: 'Example source',
        locator: `entity://sequence/${DOCUMENT_ID}`,
        workspace_root_path: '/project',
      }),
    ]);
    expect(resolveSavedArtifact).toHaveBeenCalledTimes(2);
  });

  it('refuses a success claim when the saved file cannot be verified', async () => {
    const claim = { kind: 'design' as const, id: DESIGN_ID, label: 'Missing draft' };
    const result = await prepareAgentArtifactDelivery([claim], {
      resolveSavedArtifact: async () => null,
    });
    expect(result.references).toEqual([]);
    expect(result.failedClaims).toEqual([claim]);
  });
});

it('removes internal document identities from displayed assistant prose', () => {
  const prose = `I saved the draft.\nDesign ID: ${DESIGN_ID}\nDocument ID: blank\nResource URI: waypoint://design/${DESIGN_ID}\n\nIts document ID is ${DOCUMENT_ID}; it was not opened. The document ID is blank. Document ID is blank.`;
  const cleaned = sanitizeAssistantArtifactMetadata(prose);
  expect(cleaned).toContain('I saved the draft.');
  expect(cleaned).not.toMatch(
    /document ID|design ID|resource URI|waypoint:\/\/|[0-9a-f]{8}-[0-9a-f]{4}/iu
  );
});
