import { describe, expect, it, vi } from 'vitest';
import rendererToolManifest from '../../../../../packages/core/agent-tools/renderer-tool-manifest.json';

const { mockPlatform } = vi.hoisted(() => ({
  mockPlatform: {
    fs: {
      readTextFile: vi.fn().mockResolvedValue(''),
      readDir: vi.fn().mockResolvedValue([]),
      stat: vi.fn().mockResolvedValue({ size: 0, isFile: true, isDirectory: false, mtime: 0 }),
      exists: vi.fn().mockResolvedValue(false),
      mkdir: vi.fn().mockResolvedValue(undefined),
      writeTextFile: vi.fn().mockResolvedValue(undefined),
    },
  },
}));

vi.mock('../../platform', () => ({
  platform: () => mockPlatform,
  initPlatform: vi.fn().mockResolvedValue(mockPlatform),
}));

import { ALLOWED_RENDERER_TOOLS, getAllowedRendererTool } from './renderer-tools';
import { MOLSTAR_MCP_REPRESENTATION_RECIPE_IDS } from './structure-tools';

const DUAL_REGISTERED_TOOLS = [
  'revise_protocol_step',
  'set_junction_spacer',
  'set_golden_gate_schema',
  'get_moclo_factory',
  'get_moclo_kit',
  'save_moclo_kit',
  'set_moclo_factory_stage',
  'search_moclo_parts',
  'virtual_digest',
  'place_digest_fragment',
  'set_primer_pbs_length',
  'set_primer_overhang_length',
  'set_golden_gate_offset',
  'set_pcr_polymerase',
  'remove_design_region',
  'reorder_design_regions',
  'plan_overhang_optimization',
  'apply_overhang_optimization',
  'selection_translate',
  'selection_reverse_complement',
  'selection_restriction_sites',
  'selection_gc_profile',
  'selection_find_orfs',
  'get_selection_bases',
  'inspect_indexed_current_view',
  'inspect_reference_interval',
  'set_indexed_current_view',
  'add_indexed_bigwig_url',
  'import_genome_sources',
  'configure_indexed_track',
  'compose_indexed_track_view',
  'highlight_range',
  'highlight_residues',
  'list_saved_residue_selections',
  'get_saved_residue_selection',
  'save_active_residue_selection',
  'apply_saved_residue_selection',
  'mol_list_structures',
  'mol_get_state',
  'mol_select_residues',
  'mol_set_representation',
  'mol_set_color',
  'mol_set_side_chains',
  'mol_focus',
  'backtranslate',
  'run_msa',
  'design_primers',
  'save_designed_primer',
  'add_primer_binding',
  'update_primer_binding',
  'get_primer',
] as const;

const manifestToolNames = new Set(rendererToolManifest.tools.map((tool) => tool.name));

describe(' selection tools — renderer route parity', () => {
  it('registers every dual-route tool on the CLI/MCP route (manifest + ALLOWED_RENDERER_TOOLS)', () => {
    for (const name of DUAL_REGISTERED_TOOLS) {
      expect(manifestToolNames.has(name), `${name} missing from manifest`).toBe(true);
      const definition = getAllowedRendererTool(name);
      expect(definition, `${name} missing from ALLOWED_RENDERER_TOOLS`).not.toBeNull();
      const executable =
        definition?.execution.kind === 'custom'
          ? definition.execution.handler
          : definition?.execution.createTool;
      expect(executable, name).toEqual(expect.any(Function));
      expect(definition?.inputSchema.safeParse, name).toEqual(expect.any(Function));
      expect(definition?.required_capabilities.length, name).toBeGreaterThan(0);
      expect(definition?.effects.length, name).toBeGreaterThan(0);
    }
  });

  it('keeps ALLOWED_RENDERER_TOOLS a superset covering the dual-route tools', () => {
    for (const name of DUAL_REGISTERED_TOOLS) {
      expect(Object.keys(ALLOWED_RENDERER_TOOLS)).toContain(name);
    }
  });

  it('gates primer mutations without widening the in-app agent to general workspace writes', () => {
    for (const name of [
      'save_designed_primer',
      'add_primer_binding',
      'update_primer_binding',
    ] as const) {
      const definition = getAllowedRendererTool(name);
      expect(definition?.required_capabilities, name).toContain('edit-primers');
      expect(definition?.required_capabilities, name).not.toContain('write-workspace');
    }
  });
});

const SELECTION_INPUT_TOOLS = [
  'selection_translate',
  'selection_reverse_complement',
  'selection_restriction_sites',
  'selection_gc_profile',
  'selection_find_orfs',
  'get_selection_bases',
] as const;

type ManifestInputSchema = {
  type?: string;
  properties?: Record<string, { type?: string | string[] }>;
  oneOf?: unknown;
  anyOf?: unknown;
};

describe(' M1 — advertised tools/list schema exposes refId as a top-level property', () => {
  it('every selection tool manifest inputSchema is a plain object with refId + sequence top-level (never oneOf/anyOf)', () => {
    for (const name of SELECTION_INPUT_TOOLS) {
      const entry = rendererToolManifest.tools.find((tool) => tool.name === name);
      expect(entry, `${name} present in manifest`).toBeDefined();
      const schema = entry?.inputSchema as ManifestInputSchema;

      expect(schema.oneOf, `${name} must NOT use a top-level oneOf`).toBeUndefined();
      expect(schema.anyOf, `${name} must NOT use a top-level anyOf`).toBeUndefined();
      expect(schema.type, `${name} inputSchema is a plain object`).toBe('object');

      expect(schema.properties, `${name} declares top-level properties`).toBeDefined();
      expect(schema.properties, `${name} exposes refId at the top level`).toHaveProperty('refId');
      expect(schema.properties, `${name} exposes sequence at the top level`).toHaveProperty(
        'sequence'
      );
    }
  });

  it('selection_translate specifically advertises refId as a callable string parameter', () => {
    const entry = rendererToolManifest.tools.find((tool) => tool.name === 'selection_translate');
    const schema = entry?.inputSchema as ManifestInputSchema;
    expect(schema.properties?.refId?.type).toBe('string');
  });
});

describe(' — advertised highlight_residues schema preserves ligand identity', () => {
  it('advertises compId in both compact and scoped selection forms', () => {
    const entry = rendererToolManifest.tools.find((tool) => tool.name === 'highlight_residues');
    const schema = entry?.inputSchema as {
      type?: string;
      oneOf?: unknown;
      anyOf?: unknown;
      properties?: Record<string, unknown>;
    };
    const selections = schema.properties?.selections as
      | { items?: { properties?: Record<string, unknown> } }
      | undefined;

    expect(schema.type).toBe('object');
    expect(schema.oneOf).toBeUndefined();
    expect(schema.anyOf).toBeUndefined();
    expect(schema.properties).toHaveProperty('compId');
    expect(selections?.items?.properties).toHaveProperty('compId');
  });

  it('parses ligand calls on the actual renderer allowlist schema', () => {
    const definition = getAllowedRendererTool('highlight_residues');
    expect(
      definition?.inputSchema.safeParse({
        structureRef: 'viewer:3OAA',
        chain: 'A',
        compId: 'MG',
        regions: [{ start: 601, end: 601 }],
      }).success
    ).toBe(true);
  });
});

describe(' /  — advertised Mol* control schema matches the shared runtime schema', () => {
  it('advertises every supported representation recipe to CLI/MCP clients', () => {
    const entry = rendererToolManifest.tools.find((tool) => tool.name === 'mol_set_representation');
    const schema = entry?.inputSchema as {
      properties?: { representation?: { enum?: string[] } };
    };

    expect(schema.properties?.representation?.enum).toEqual([
      ...MOLSTAR_MCP_REPRESENTATION_RECIPE_IDS,
    ]);
  });
});
