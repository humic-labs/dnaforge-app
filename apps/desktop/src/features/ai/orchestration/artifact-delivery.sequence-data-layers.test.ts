import { beforeEach, expect, it, vi } from 'vitest';
import type { ChatMessage } from './chat-types';

const native = vi.hoisted(() => ({
  file: vi.fn(),
  exists: vi.fn(),
  inspect: vi.fn(),
}));

vi.mock('../../../db/workspace-catalog', async (original) => ({
  ...(await original<typeof import('../../../db/workspace-catalog')>()),
  getCurrentCatalogFileForEntity: native.file,
}));
vi.mock('../../../platform', async (original) => ({
  ...(await original<typeof import('../../../platform')>()),
  platform: () => ({ fs: { exists: native.exists }, sequenceDataLayers: { run: native.inspect } }),
}));

import { collectCreatedArtifactClaims, prepareAgentArtifactDelivery } from './artifact-delivery';

const id = `layer-${'a'.repeat(64)}`;
const root = '/project/Engineering';
const path = `${root}/.dnaforge/sequence-data-layers/${id}.dnalayer.json`;
const revision = 'b'.repeat(64);
const claim = {
  kind: 'sequence-data-layer' as const,
  id,
  label: 'Measured expression',
  workspaceRoot: root,
  path,
  revision,
};
const published = {
  ok: true,
  status: 'published',
  data: { id, path, revision, label: claim.label, availability: { status: 'current' } },
};
const saved = {
  status: 'published',
  document: { id },
  path,
  revision,
  availability: { status: 'current' },
};

function tool(output: unknown, operation = 'create'): ChatMessage {
  return {
    id: crypto.randomUUID(),
    role: 'tool',
    toolName: 'sequence_data_layers',
    content: JSON.stringify({ input: { operation, project: 'Engineering' }, output }),
    createdAt: 1,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  native.exists.mockResolvedValue(true);
  native.inspect.mockResolvedValue(saved);
});

it.each(['create', 'inspect'])('collects a confirmed published layer from %s', (operation) => {
  expect(collectCreatedArtifactClaims([tool(published, operation)])).toEqual([claim]);
});

it('collects the native agent activity envelope for a published layer', () => {
  const activity: ChatMessage = {
    id: 'layer-activity',
    role: 'activity',
    createdAt: 1,
    content: JSON.stringify({
      type: 'agent.activity',
      event: {
        toolCalls: [
          {
            name: 'sequence_data_layers',
            mcpServer: 'dnaforge',
            status: 'completed',
            input: { operation: 'create', project: 'Engineering' },
            output: { structuredContent: { ok: true, result: published } },
          },
        ],
      },
    }),
  };
  expect(collectCreatedArtifactClaims([activity])).toEqual([claim]);
});

it.each([
  { ...published, ok: false },
  { ...published, status: 'needs-input' },
  { ...published, status: 'target' },
  { ...published, status: 'listed' },
  { ...published, status: 'failed', disposition: 'publication-uncertain' },
  { ...published, data: { ...published.data, availability: { status: 'stale' } } },
  { ...published, data: { ...published.data, availability: { status: 'unavailable' } } },
  { ...published, data: { ...published.data, id: 'unconfirmed-layer' } },
  { ...published, data: { ...published.data, revision: 'unknown' } },
  { ...published, data: { ...published.data, path: '/project/loose.json' } },
  {
    ...published,
    data: { ...published.data, path: `.dnaforge/sequence-data-layers/${id}.dnalayer.json` },
  },
  { ok: false, result: published },
])('does not collect an unconfirmed or stale layer: %j', (output) => {
  expect(collectCreatedArtifactClaims([tool(output)])).toEqual([]);
});

it('rechecks the exact saved native layer before attaching a file reference', async () => {
  const result = await prepareAgentArtifactDelivery([claim]);
  expect(native.inspect).toHaveBeenCalledWith({ operation: 'inspect', project: root, id });
  expect(native.file).not.toHaveBeenCalled();
  expect(result.failedClaims).toEqual([]);
  expect(result.references).toEqual([
    expect.objectContaining({
      entity_type: 'file',
      locator: `git://${path}`,
      display_label: claim.label,
      workspace_root_path: root,
    }),
  ]);
});

it.each([
  { status: 'failed', disposition: 'publication-uncertain' },
  { status: 'needs-input' },
  { document: { id: `layer-${'c'.repeat(64)}` } },
  { path: '/other-project/layer.dnalayer.json' },
  { revision: 'c'.repeat(64) },
  { availability: { status: 'stale', reason: 'annotations-changed' } },
  { availability: { status: 'unavailable', reason: 'Target is missing' } },
])('refuses a native layer that no longer verifies the saved claim: %j', async (change) => {
  native.inspect.mockResolvedValue({ ...saved, ...change });
  expect(await prepareAgentArtifactDelivery([claim])).toEqual({
    references: [],
    failedClaims: [claim],
  });
});

it('refuses a missing saved layer', async () => {
  native.inspect.mockRejectedValue(new Error('The saved layer is missing'));
  expect(await prepareAgentArtifactDelivery([claim])).toEqual({
    references: [],
    failedClaims: [claim],
  });
});
