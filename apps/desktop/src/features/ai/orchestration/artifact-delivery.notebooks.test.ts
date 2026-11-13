import { beforeEach, expect, it, vi } from 'vitest';
import type { ChatMessage } from './chat-types';

const native = vi.hoisted(() => ({
  file: vi.fn(),
  root: vi.fn(),
  exists: vi.fn(),
  inspect: vi.fn(),
}));

vi.mock('../../../db/workspace-catalog', async (original) => ({
  ...(await original<typeof import('../../../db/workspace-catalog')>()),
  getCurrentCatalogFileForEntity: native.file,
  getCatalogWorkspaceRootForFilePath: native.root,
}));
vi.mock('../../../platform', async (original) => ({
  ...(await original<typeof import('../../../platform')>()),
  platform: () => ({ fs: { exists: native.exists }, notebook: { execute: native.inspect } }),
}));

import {
  collectCreatedArtifactClaims,
  prepareAgentArtifactDelivery,
  repairHistoricalArtifactDelivery,
} from './artifact-delivery';
import { claimsCompletedBiologyArtifact } from './assistant-artifact-prose';

const id = '7301ab6c-501e-4a6c-bfa5-4fc2fe0f5695::agent-notebook-1234567890abcdef1234567890abcdef';
const root = '/project/Engineering';
const path = `${root}/Expression planning`;
const fingerprint = 'a7f12d642ceeb17f';
const claim = {
  kind: 'notebook' as const,
  id,
  label: 'Expression planning',
  workspaceRoot: root,
  revision: fingerprint,
};
const saved = {
  documentId: id,
  pageId: id,
  workspaceRoot: root,
  path,
  title: claim.label,
  revision: 'owner:1:page',
  persistedRevision: 'owner:1:page',
  canonicalFingerprint: fingerprint,
  publication: {
    status: 'settled',
    canonicalFingerprint: fingerprint,
    projectionFingerprint: 'projection-fixture',
  },
  ready: true,
  dirty: false,
  saving: false,
};

function tool(name: string, output: unknown, input?: unknown): ChatMessage {
  return {
    id: crypto.randomUUID(),
    role: 'tool',
    toolName: name,
    content: JSON.stringify({ input, output, isError: false }),
    createdAt: 1,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  native.file.mockResolvedValue({ path, file_kind: 'waypoint-notebook' });
  native.root.mockResolvedValue(root);
  native.exists.mockResolvedValue(true);
  native.inspect.mockResolvedValue(saved);
});

it.each(['create_notebook', 'update_notebook'])(
  'collects saved %s results with their project and content revision',
  (name) => {
    expect(
      collectCreatedArtifactClaims([
        tool(name, {
          notebookId: id,
          title: claim.label,
          workspaceRoot: root,
          packagePath: path,
          revision: fingerprint,
        }),
      ])
    ).toEqual([claim]);
  }
);

it.each(['create', 'save', 'rename'])('collects the native notebook %s receipt', (kind) => {
  expect(
    collectCreatedArtifactClaims([
      tool('notebook_document', saved, { pageId: id, operation: { kind } }),
    ])
  ).toEqual([claim]);
});

it.each([
  { input: { operation: { kind: 'inspect' } }, output: saved },
  { input: { operation: { kind: 'save' } }, output: { ...saved, dirty: true } },
  { input: { operation: { kind: 'save' } }, output: { ...saved, saving: true } },
  { input: { operation: { kind: 'save' } }, output: { ...saved, persistedRevision: 'older' } },
  { input: { operation: { kind: 'save' } }, output: { ok: false, result: saved } },
])('does not collect inspection, unsaved or failed output: %j', ({ input, output }) => {
  expect(collectCreatedArtifactClaims([tool('notebook_document', output, input)])).toEqual([]);
});

it('verifies the real native owner before attaching an openable notebook reference', async () => {
  const result = await prepareAgentArtifactDelivery([claim]);
  expect(native.inspect).toHaveBeenCalledWith({
    documentId: id,
    operation: { kind: 'inspect', offset: 0, limit: 1 },
  });
  expect(result.failedClaims).toEqual([]);
  expect(result.references).toEqual([
    expect.objectContaining({
      entity_type: 'notebook',
      locator: `entity://page/${id}`,
      workspace_root_path: root,
    }),
  ]);
});

it.each([
  { documentId: 'different-page' },
  { workspaceRoot: '/other-project' },
  { path: '/project/plain.md' },
  { canonicalFingerprint: 'different' },
  { dirty: true },
  { saving: true },
  { ready: false },
  { persistedRevision: 'older' },
  { publication: { status: 'pending', canonicalFingerprint: fingerprint, reason: 'projection' } },
  { publication: { status: 'conflict', canonicalFingerprint: fingerprint, reason: 'comparison' } },
  { publication: undefined },
])('refuses a native notebook state that differs from its saved claim: %j', async (change) => {
  native.inspect.mockResolvedValue({ ...saved, ...change });
  expect(await prepareAgentArtifactDelivery([claim])).toEqual({
    references: [],
    failedClaims: [claim],
  });
});

it('refuses a loose Markdown file or a catalog record in another project', async () => {
  native.file.mockResolvedValue({ path: `${root}/notes.md`, file_kind: 'text' });
  expect((await prepareAgentArtifactDelivery([claim])).failedClaims).toEqual([claim]);
  native.file.mockResolvedValue({ path, file_kind: 'waypoint-notebook' });
  native.root.mockResolvedValue('/other-project');
  expect((await prepareAgentArtifactDelivery([claim])).failedClaims).toEqual([claim]);
  expect(native.inspect).not.toHaveBeenCalled();
});

it('refuses a missing native package even when a tool claimed success', async () => {
  native.inspect.mockRejectedValue(new Error('Native notebook metadata is missing'));
  expect(await prepareAgentArtifactDelivery([claim])).toEqual({
    references: [],
    failedClaims: [claim],
  });
});

it('recognizes notebook completion claims without classifying ordinary Markdown as a notebook', () => {
  expect(claimsCompletedBiologyArtifact('I saved the notebook.')).toBe(true);
  expect(
    claimsCompletedBiologyArtifact('Created the notebook entry for expression planning.')
  ).toBe(true);
  expect(claimsCompletedBiologyArtifact('I saved a Markdown source file.')).toBe(false);
});

it('retains the original notebook explanation when an older receipt cannot be verified', async () => {
  const answer: ChatMessage = {
    id: 'older-answer',
    turnId: 'older-turn',
    role: 'assistant',
    createdAt: 1,
    content:
      'I saved the notebook.\n\nThe original explanation and source observations remain available here.',
    referenceIds: ['older-notebook-reference'],
  };
  const repaired = await repairHistoricalArtifactDelivery([answer]);
  expect(repaired[0].content).toContain(answer.content);
  expect(repaired[0].content).toContain("I couldn't verify a saved artifact");
  expect(repaired[0].referenceIds).toEqual(answer.referenceIds);
  expect((await repairHistoricalArtifactDelivery(repaired))[0].content).toBe(repaired[0].content);
});
