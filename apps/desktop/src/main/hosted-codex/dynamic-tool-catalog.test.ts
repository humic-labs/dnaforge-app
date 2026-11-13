import { describe, expect, it } from 'vitest';
import { HOSTED_NATIVE_TOOL_DEFINITIONS } from '@waypoint/hosted-ai-contract';

import rendererToolManifest from '../../../../../packages/core/agent-tools/renderer-tool-manifest.json';
import {
  buildHostedCodexToolCatalog,
  DENIED_NATIVE_TOOL_NAMES,
  hostedCodexCanonicalToolName,
  hostedCodexToolWireName,
  hostedCodexWireInputSchema,
  HostedCodexToolCatalogError,
  selectHostedCodexTools,
} from './dynamic-tool-catalog';

interface ManifestTool {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  effects: string[];
  requiresWorkspace?: boolean;
  exposure: { kind: 'shared' } | { kind: 'mcp-only'; reason: string };
}

const manifestTools = (rendererToolManifest as { tools: ManifestTool[] }).tools;
const nativeTools = HOSTED_NATIVE_TOOL_DEFINITIONS.map((tool) => ({
  ...tool,
  requiresWorkspace: false,
}));
const canonicalTools = [
  ...manifestTools.filter((tool) => tool.exposure.kind === 'shared'),
  ...nativeTools,
];
const readOnlyNames = canonicalTools
  .filter((tool) => tool.effects.every((effect) => effect === 'read-only'))
  .map((tool) => tool.name)
  .sort();

describe('Hosted Codex dynamic tool catalog', () => {
  it('includes the app-owned native tool contract in the App Server catalog', () => {
    const full = buildHostedCodexToolCatalog({
      allowEffects: ['read-only', 'mutating', 'ui-bound'],
    });
    const nativeNames = HOSTED_NATIVE_TOOL_DEFINITIONS.map((tool) => tool.name).sort();
    const exposedNativeNames = full.tools
      .filter((tool) => nativeNames.includes(tool.name as (typeof nativeNames)[number]))
      .map((tool) => tool.name)
      .sort();

    expect(exposedNativeNames).toEqual(nativeNames);
    expect(full.tools.find((tool) => tool.name === 'Write')).toMatchObject({
      effects: ['mutating'],
      requiresWorkspace: false,
    });
  });

  it('tells Hosted how to create an owned design and use cross-project sources', () => {
    const full = buildHostedCodexToolCatalog({
      allowEffects: ['read-only', 'mutating', 'ui-bound'],
    });
    const createDesign = full.tools.find((tool) => tool.name === 'create_design');
    const addRegion = full.tools.find((tool) => tool.name === 'add_design_region');

    expect(createDesign).toMatchObject({ requiresWorkspace: true });
    expect(createDesign?.description).toContain('destinationProject');
    expect(
      (createDesign?.inputSchema.properties as Record<string, unknown>).destinationProject
    ).toBeDefined();
    expect(addRegion?.description).toContain('any open project');
    expect(addRegion?.description).toContain('call the tool');
  });

  it('exposes exactly the canonical read-only tools by default', () => {
    const catalog = buildHostedCodexToolCatalog();
    expect(catalog.tools.map((tool) => tool.name)).toEqual(readOnlyNames);
    expect(catalog.tools.length).toBeGreaterThan(0);
  });

  it('admits external-submit tools only when the caller explicitly allows that effect', () => {
    expect(buildHostedCodexToolCatalog().tools.map((tool) => tool.name)).not.toContain(
      'compute.submit'
    );
    expect(
      buildHostedCodexToolCatalog({ allowEffects: ['external-submit'] }).tools.map(
        (tool) => tool.name
      )
    ).toContain('compute.submit');
    expect(
      buildHostedCodexToolCatalog({
        allowEffects: ['read-only', 'ui-bound', 'mutating'],
      }).tools.map((tool) => tool.name)
    ).not.toContain('administration');
  });

  it('projects each tool exactly as the manifest declares it', () => {
    const catalog = buildHostedCodexToolCatalog();
    for (const tool of catalog.tools) {
      const declared = canonicalTools.find((entry) => entry.name === tool.name);
      expect(declared, `${tool.name} must come from a canonical contract`).toBeDefined();
      expect(tool.description).toBe(declared?.description);
      expect(tool.inputSchema).toEqual(declared?.inputSchema);
      expect(tool.effects).toEqual(declared?.effects);
      expect(tool.requiresWorkspace).toBe(declared?.requiresWorkspace === true);
    }
  });

  it('makes the pinned App Server schema lowering explicit without changing canonical authority', () => {
    const canonical = {
      type: 'object',
      properties: {
        count: { type: 'integer', minimum: 1, maximum: 10, default: 1 },
        label: { type: 'string', minLength: 2, pattern: '^[A-Z]+$' },
        kind: { const: 'region' },
      },
      required: ['count', 'label'],
      additionalProperties: false,
    };

    expect(hostedCodexWireInputSchema(canonical)).toEqual({
      type: 'object',
      properties: {
        count: { type: 'integer' },
        label: { type: 'string' },
        kind: { type: 'string', enum: ['region'] },
      },
      required: ['count', 'label'],
      additionalProperties: false,
    });
    expect(canonical.properties.count.minimum).toBe(1);
    expect(canonical.properties.label.pattern).toBe('^[A-Z]+$');
  });

  it('projects historical primer direction tuples onto a single App Server item schema', () => {
    const canonical = {
      type: 'object',
      properties: {
        directions: {
          type: 'array',
          minItems: 2,
          maxItems: 2,
          items: [
            { type: 'string', const: 'forward' },
            { type: 'string', const: 'reverse' },
          ],
        },
      },
      required: ['directions'],
      additionalProperties: false,
    };
    const original = structuredClone(canonical);

    expect(hostedCodexWireInputSchema(canonical)).toEqual({
      type: 'object',
      properties: {
        directions: {
          type: 'array',
          description:
            'Items must follow these schemas in order: [{"type":"string","const":"forward"},{"type":"string","const":"reverse"}].',
          items: {
            anyOf: [
              { type: 'string', enum: ['forward'] },
              { type: 'string', enum: ['reverse'] },
            ],
          },
        },
      },
      required: ['directions'],
      additionalProperties: false,
    });
    expect(canonical).toEqual(original);
  });

  it('admits no mutating or ui-bound tool at the default tier', () => {
    const catalog = buildHostedCodexToolCatalog();
    for (const tool of catalog.tools) {
      expect(tool.effects, `${tool.name} must be read-only`).toEqual(['read-only']);
    }
    const exposed = new Set(catalog.tools.map((tool) => tool.name));
    const effectful = manifestTools.filter((tool) =>
      tool.effects.some((effect) => effect !== 'read-only')
    );
    expect(effectful.length).toBeGreaterThan(0);
    for (const tool of effectful) {
      expect(exposed.has(tool.name), `${tool.name} must not be exposed`).toBe(false);
    }
  });

  it('requires every effect of a tool to be allowed, not just one of them', () => {
    const manifest = {
      tools: [
        {
          name: 'mixed_effects',
          description: 'A tool that mutates data and updates the view.',
          inputSchema: { type: 'object', properties: {} },
          effects: ['mutating', 'ui-bound'],
          exposure: { kind: 'shared' },
        },
      ],
    };
    for (const allowedEffect of ['mutating', 'ui-bound'] as const) {
      const partial = buildHostedCodexToolCatalog({
        manifest,
        allowEffects: ['read-only', allowedEffect],
      });
      expect(partial.tools.some((tool) => tool.name === 'mixed_effects')).toBe(false);
    }

    const full = buildHostedCodexToolCatalog({
      manifest,
      allowEffects: ['read-only', 'mutating', 'ui-bound'],
    });
    expect(full.tools.some((tool) => tool.name === 'mixed_effects')).toBe(true);
  });

  it('never lets a wider tier admit a Codex-native capability', () => {
    const full = buildHostedCodexToolCatalog({
      allowEffects: ['read-only', 'mutating', 'ui-bound'],
    });
    for (const name of DENIED_NATIVE_TOOL_NAMES) {
      expect(
        full.tools.some((tool) => tool.name === name),
        `${name} must never appear`
      ).toBe(false);
    }
    expect(DENIED_NATIVE_TOOL_NAMES.has('shell')).toBe(true);
    expect(DENIED_NATIVE_TOOL_NAMES.has('apply_patch')).toBe(true);
    expect(DENIED_NATIVE_TOOL_NAMES.has('web_search')).toBe(true);
    expect(DENIED_NATIVE_TOOL_NAMES.has('mcp')).toBe(true);
    expect(DENIED_NATIVE_TOOL_NAMES.has('subagent')).toBe(true);
  });

  it('refuses to build a catalog that contains a Codex-native capability', () => {
    for (const name of ['shell', 'apply_patch', 'web_search', 'mcp', 'subagent']) {
      expect(() =>
        buildHostedCodexToolCatalog({
          manifest: {
            tools: [
              {
                name,
                description: 'a plausible-looking description',
                inputSchema: { type: 'object', properties: {} },
                effects: ['read-only'],
                exposure: { kind: 'shared' },
              },
            ],
          },
        })
      ).toThrow(/must never be exposed through this runtime/u);
    }
  });

  it('refuses a manifest tool that does not declare what it does', () => {
    const base = {
      name: 'some_tool',
      description: 'does a thing',
      inputSchema: { type: 'object', properties: {} },
      effects: ['read-only'],
      exposure: { kind: 'shared' },
    };
    expect(() =>
      buildHostedCodexToolCatalog({ manifest: { tools: [{ ...base, effects: [] }] } })
    ).toThrow(/does not declare its effects/u);
    expect(() =>
      buildHostedCodexToolCatalog({ manifest: { tools: [{ ...base, effects: ['sideways'] }] } })
    ).toThrow(/unknown effect/u);
    expect(() =>
      buildHostedCodexToolCatalog({ manifest: { tools: [{ ...base, description: '  ' }] } })
    ).toThrow(/no description for the model to read/u);
    expect(() =>
      buildHostedCodexToolCatalog({ manifest: { tools: [{ ...base, inputSchema: null }] } })
    ).toThrow(/no input schema/u);
    expect(() =>
      buildHostedCodexToolCatalog({ manifest: { tools: [{ ...base, name: '' }] } })
    ).toThrow(/a tool with no name/u);
    expect(() => buildHostedCodexToolCatalog({ manifest: { tools: 'not-an-array' } })).toThrow(
      /does not declare a tools array/u
    );
  });

  it('never exposes an MCP-only descriptor through Hosted, even at the widest effect tier', () => {
    const shared = {
      name: 'shared_read',
      description: 'Shared read.',
      inputSchema: { type: 'object', properties: {} },
      effects: ['read-only'],
      exposure: { kind: 'shared' },
    };
    const mcpOnly = {
      ...shared,
      name: 'mcp_read',
      exposure: { kind: 'mcp-only', reason: 'Requires an MCP client-owned stream.' },
    };

    const catalog = buildHostedCodexToolCatalog({
      manifest: { tools: [shared, mcpOnly] },
      allowEffects: ['read-only', 'mutating', 'ui-bound'],
    });

    expect(catalog.tools.map((tool) => tool.name)).toContain('shared_read');
    expect(catalog.tools.map((tool) => tool.name)).not.toContain('mcp_only');
  });

  it('fails closed on missing or malformed exposure metadata', () => {
    const base = {
      name: 'some_tool',
      description: 'Does a thing.',
      inputSchema: { type: 'object', properties: {} },
      effects: ['read-only'],
    };

    expect(() => buildHostedCodexToolCatalog({ manifest: { tools: [base] } })).toThrow(
      /does not declare its exposure/u
    );
    expect(() =>
      buildHostedCodexToolCatalog({
        manifest: {
          tools: [{ ...base, exposure: { kind: 'mcp-only', reason: '  ' } }],
        },
      })
    ).toThrow(/declares an invalid exposure/u);
  });

  it('fails closed when a turn asks for a tool outside its catalog', () => {
    const catalog = buildHostedCodexToolCatalog();
    expect(() => selectHostedCodexTools(catalog, ['definitely_not_a_tool'])).toThrow(
      HostedCodexToolCatalogError
    );
    expect(() => selectHostedCodexTools(catalog, ['definitely_not_a_tool'])).toThrow(
      /not in this turn's tool catalog/u
    );

    const mutating = manifestTools.find((tool) => tool.effects.includes('mutating'));
    expect(mutating).toBeDefined();
    expect(() => selectHostedCodexTools(catalog, [mutating!.name])).toThrow(
      /not in this turn's tool catalog/u
    );
  });

  it('resolves the tools a turn legitimately asked for', () => {
    const catalog = buildHostedCodexToolCatalog();
    const wanted = catalog.tools.slice(0, 3).map((tool) => tool.name);
    expect(selectHostedCodexTools(catalog, wanted).map((tool) => tool.name)).toEqual(wanted);
  });

  it('projects dotted canonical names onto a reversible Responses wire name', () => {
    const catalog = buildHostedCodexToolCatalog({
      allowEffects: ['read-only', 'ui-bound', 'mutating'],
    });
    const dotted = catalog.tools.find((tool) => tool.name.includes('.'));
    expect(dotted).toBeDefined();
    const wireName = hostedCodexToolWireName(dotted!.name);
    expect(wireName).toMatch(/^[a-zA-Z0-9_-]+$/u);
    expect(wireName).not.toBe(dotted!.name);
    expect(hostedCodexCanonicalToolName(catalog.tools, wireName)).toBe(dotted!.name);
    expect(hostedCodexToolWireName('list_files')).toBe('list_files');
    expect(hostedCodexCanonicalToolName(catalog.tools, 'not_offered')).toBeNull();
  });

  it('gives the catalog a stable identity that moves when the surface moves', () => {
    expect(buildHostedCodexToolCatalog().digest).toBe(buildHostedCodexToolCatalog().digest);
    expect(buildHostedCodexToolCatalog().digest).not.toBe(
      buildHostedCodexToolCatalog({ allowEffects: ['read-only', 'mutating'] }).digest
    );
    expect(buildHostedCodexToolCatalog().digest).toMatch(/^[0-9a-f]{64}$/u);
  });
});
