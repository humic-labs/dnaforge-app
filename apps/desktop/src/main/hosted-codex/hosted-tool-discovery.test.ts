import type { DiscoveryCandidate } from '../../shared/discovery-ranking';
import { describe, expect, it, vi } from 'vitest';
import { HOSTED_NATIVE_TOOL_DEFINITIONS } from '@waypoint/hosted-ai-contract';
import { buildHostedCodexToolCatalog } from './dynamic-tool-catalog';
import { HOSTED_CODEX_RESERVED_TOOLS } from './hosted-session';
import {
  buildHostedProviderToolCatalog,
  createHostedToolDiscovery,
  discoverHostedTools,
  resolveHostedToolDispatch,
} from './hosted-tool-discovery';

function fullCatalog() {
  return buildHostedCodexToolCatalog({
    allowEffects: ['read-only', 'mutating', 'ui-bound', 'external-submit'],
    omitNames: HOSTED_CODEX_RESERVED_TOOLS,
  });
}

describe('Hosted app-owned tool discovery and dispatch', () => {
  it('resolves exact admitted action names without a remote ranker call', async () => {
    const catalog = fullCatalog();
    const rank = vi.fn(async () => null);
    const page = await createHostedToolDiscovery(catalog, rank)({ query: 'file_document' });
    expect(page.tools).toEqual([catalog.tools.find((tool) => tool.name === 'file_document')]);
    expect(page.nextOffset).toBeNull();
    expect(rank).not.toHaveBeenCalled();
  });

  it('finds natural operation requests when the semantic ranker is unavailable', () => {
    const catalog = fullCatalog();
    for (const [query, name] of [
      ['stage selected files', 'project_history'],
      ['review a CSV import', 'import_review'],
      ['save a closed text file', 'file_document'],
      ['change display zoom', 'administration'],
    ])
      expect(
        discoverHostedTools(catalog, { query, limit: 4 }).tools.map((tool) => tool.name),
        query
      ).toContain(name);
  });
  it('ranks the admitted set once per query and paginates original objects', async () => {
    const catalog = fullCatalog();
    const rank = vi.fn(async (_query: string, _candidates: readonly DiscoveryCandidate[]) => [
      'design_primers',
      'get_sequence',
    ]);
    const discover = createHostedToolDiscovery(catalog, rank);
    const first = await discover({ query: 'amplify the coding region', limit: 1 });
    const second = await discover({
      query: 'amplify the coding region',
      limit: 1,
      offset: first.nextOffset,
    });
    expect(first.tools[0]).toBe(catalog.tools.find((t) => t.name === 'design_primers'));
    expect(second.tools[0]?.name).toBe('get_sequence');
    expect(second.nextOffset).toBeNull();
    expect(rank).toHaveBeenCalledTimes(1);
    expect(rank.mock.calls[0]?.[1]).not.toContainEqual(expect.objectContaining({ name: 'Read' }));
  });

  it('falls back exactly to lexical search and skips Jev for enumeration', async () => {
    const catalog = fullCatalog();
    const rank = vi.fn(async () => null);
    const discover = createHostedToolDiscovery(catalog, rank);
    expect(await discover({ query: '' })).toEqual(discoverHostedTools(catalog, { query: '' }));
    expect(rank).not.toHaveBeenCalled();
    expect(await discover({ query: 'primer' })).toEqual(
      discoverHostedTools(catalog, { query: 'primer' })
    );
  });

  it('keeps earlier pages stable after reaching the retained-query limit', async () => {
    const catalog = fullCatalog();
    const rank = vi.fn(async (_query: string, _candidates: readonly DiscoveryCandidate[]) => [
      'design_primers',
      'get_sequence',
    ]);
    const discover = createHostedToolDiscovery(catalog, rank);
    await discover({ query: 'probe-0', limit: 1 });
    for (let i = 1; i <= 16; i++) await discover({ query: `probe-${i}`, limit: 1 });
    const next = await discover({ query: 'probe-0', offset: 1, limit: 1 });
    expect(next.tools[0]?.name).toBe('get_sequence');
    expect(rank).toHaveBeenCalledTimes(16);
  });

  it('never expands read-only authority with ranked IDs', async () => {
    const catalog = buildHostedCodexToolCatalog({ omitNames: HOSTED_CODEX_RESERVED_TOOLS });
    const rank = vi.fn(async (_query: string, _candidates: readonly DiscoveryCandidate[]) => [
      'create_design',
      'get_workspace',
    ]);
    const result = await createHostedToolDiscovery(catalog, rank)({ query: 'canvas' });
    expect(result.tools.map((t) => t.name)).toEqual(['get_workspace']);
    expect(rank.mock.calls[0]?.[1]).not.toContainEqual(
      expect.objectContaining({ id: 'create_design' })
    );
  });
  it('bounds provider registration while retaining the complete execution catalog and every native tool', () => {
    const canonical = fullCatalog();
    const before = canonical.tools.map((tool) => tool.name);
    const provider = buildHostedProviderToolCatalog(canonical);
    const natives = HOSTED_NATIVE_TOOL_DEFINITIONS.filter((tool) => before.includes(tool.name));
    expect(natives).toHaveLength(14);
    expect(provider.tools).toHaveLength(16);
    expect(provider.tools.map((tool) => tool.name)).toEqual(
      expect.arrayContaining(natives.map((tool) => tool.name))
    );
    expect(canonical.tools.map((tool) => tool.name)).toEqual(before);
    expect(canonical.tools.some((tool) => tool.name === 'dnaforge_execute_tool')).toBe(false);
    expect(canonical.tools.some((tool) => tool.name === 'dnaforge_discover_tools')).toBe(false);
  });

  it('keeps new actions discoverable as the catalog grows without increasing the provider request', () => {
    const canonical = fullCatalog();
    const sample = canonical.tools.find((tool) => tool.name === 'get_workspace')!;
    const grown = {
      ...canonical,
      tools: [
        ...canonical.tools,
        ...Array.from({ length: 200 }, (_, index) => ({
          ...sample,
          name: `fixture_action_${index}`,
        })),
      ],
    };
    expect(buildHostedProviderToolCatalog(grown).tools).toHaveLength(16);
    expect(discoverHostedTools(grown, { query: 'fixture_action_199' }).tools).toContainEqual({
      ...sample,
      name: 'fixture_action_199',
    });
  });

  it('returns original names, exact schemas and effects and allows every eligible renderer action to be enumerated', () => {
    const canonical = fullCatalog();
    const nativeNames = new Set<string>(HOSTED_NATIVE_TOOL_DEFINITIONS.map((tool) => tool.name));
    const found: string[] = [];
    let offset: number | null = 0;
    while (offset !== null) {
      const page = discoverHostedTools(canonical, { query: '', offset, limit: 8 });
      for (const tool of page.tools) {
        expect(tool).toBe(canonical.tools.find((candidate) => candidate.name === tool.name));
        found.push(tool.name);
      }
      offset = page.nextOffset;
    }
    expect(found.sort()).toEqual(
      canonical.tools
        .filter((tool) => !nativeNames.has(tool.name))
        .map((tool) => tool.name)
        .sort()
    );
    expect(new Set(found).size).toBe(found.length);
  });

  it('resolves execution to the original action and parsed arguments rather than a wrapper policy', () => {
    const canonical = fullCatalog();
    const resolved = resolveHostedToolDispatch(canonical, {
      name: 'create_design',
      arguments: '{"name":"Owned design"}',
    });
    expect(resolved.tool).toBe(canonical.tools.find((tool) => tool.name === 'create_design'));
    expect(resolved.input).toEqual({ name: 'Owned design' });
    expect(resolved.tool.effects).toContain('mutating');
  });

  it('refuses unknown, reserved, native and unavailable effect-tier actions', () => {
    const canonical = fullCatalog();
    for (const name of [
      'unknown_action',
      'close_tab',
      'NotebookEdit',
      'Read',
      'dnaforge_execute_tool',
    ]) {
      expect(() => resolveHostedToolDispatch(canonical, { name, arguments: '{}' })).toThrow();
    }
    const readOnly = buildHostedCodexToolCatalog({ omitNames: HOSTED_CODEX_RESERVED_TOOLS });
    expect(() =>
      resolveHostedToolDispatch(readOnly, { name: 'create_design', arguments: '{}' })
    ).toThrow();
    expect(
      discoverHostedTools(readOnly, { query: 'create_design' }).tools.map((tool) => tool.name)
    ).not.toContain('create_design');
  });

  it('refuses malformed envelopes and non-object action arguments before invoking any original handler', () => {
    const canonical = fullCatalog();
    for (const argumentsValue of ['not json', 'null', '[]', 'true']) {
      expect(() =>
        resolveHostedToolDispatch(canonical, { name: 'get_workspace', arguments: argumentsValue })
      ).toThrow();
    }
    expect(() =>
      resolveHostedToolDispatch(canonical, { name: 'get_workspace', arguments: '{}', extra: true })
    ).toThrow();
    expect(() => discoverHostedTools(canonical, { query: '', limit: 0 })).toThrow();
    expect(() => discoverHostedTools(canonical, { query: '', limit: 9 })).toThrow();
  });
});
