import { AjvJsonSchemaValidator } from '@modelcontextprotocol/sdk/validation/ajv-provider.js';
import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { asSchema } from 'ai';
import {
  portableToolSchema,
  rendererInputSchema,
  wrapRendererOutputSchema,
} from './tool-json-schema';
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

import {
  ALLOWED_RENDERER_TOOLS,
  hostedToolNameForRenderer,
  rendererToolNameForHosted,
  type RendererToolName,
} from './renderer-tools';

type ManifestEntry = {
  name: string;
  inputSchema: Record<string, unknown>;
  outputSchema: Record<string, unknown>;
  shape: string;
  effects: string[];
  required_capabilities: string[];
  conditional_required_capabilities?: string[];
  requiresWorkspace: boolean;
  conditionallyRequiresWorkspace?: boolean;
  workspaceGrounding?:
    | 'always'
    | 'when-ref-id'
    | 'when-existing-reference'
    | 'when-workspace-file'
    | 'none';
  emptyInputReason?: string;
  mcpAnnotations?: Record<string, boolean>;
  sidecarOrchestrated?: boolean;
  audit_required?: boolean;
  exposure: { kind: 'shared' } | { kind: 'mcp-only'; reason: string };
};

const manifestTools = rendererToolManifest.tools as ManifestEntry[];
const manifestByName = new Map(manifestTools.map((t) => [t.name, t]));

describe('Guard 0 — checked-in manifest is an exact catalog projection', () => {
  it('projects every descriptor schema and transport field without a second hand-authored copy', () => {
    for (const [name, definition] of Object.entries(ALLOWED_RENDERER_TOOLS)) {
      const entry = manifestByName.get(name);
      expect(entry, `${name} missing from generated manifest`).toBeDefined();
      expect(entry?.name).toBe(definition.name);
      expect(entry?.description).toBe(definition.description);
      expect(entry?.inputSchema).toEqual(rendererInputSchema(definition));
      expect(entry?.outputSchema).toEqual(
        definition.outputSchema
          ? wrapRendererOutputSchema(portableToolSchema(definition.outputSchema))
          : undefined
      );
      expect(entry?.shape).toBe(definition.shape);
      expect(entry?.effects).toEqual([...definition.effects]);
      expect(entry?.required_capabilities).toEqual([...definition.required_capabilities]);
      expect(entry?.conditional_required_capabilities ?? []).toEqual([
        ...definition.conditional_required_capabilities,
      ]);
      expect(entry?.requiresWorkspace).toBe(definition.requiresWorkspace);
      expect(entry?.conditionallyRequiresWorkspace ?? false).toBe(
        definition.conditionallyRequiresWorkspace
      );
      expect(entry?.workspaceGrounding).toBe(definition.workspaceGrounding);
      expect(entry?.emptyInputReason).toBe(definition.emptyInputReason);
      expect(entry?.mcpAnnotations).toEqual(definition.mcpAnnotations);
      expect(entry?.sidecarOrchestrated ?? false).toBe(definition.sidecarOrchestrated ?? false);
      expect(entry?.exposure).toEqual(definition.exposure);
    }
  });

  it('derives provider aliases and history presentation from the same descriptors', () => {
    const providerToolNames = Object.fromEntries(
      Object.values(ALLOWED_RENDERER_TOOLS).flatMap((definition) =>
        definition.providerAlias ? [[definition.name, definition.providerAlias]] : []
      )
    );
    const historyTools = Object.fromEntries(
      Object.values(ALLOWED_RENDERER_TOOLS).flatMap((definition) =>
        definition.historyPresentation ? [[definition.name, definition.historyPresentation]] : []
      )
    );

    expect(rendererToolManifest.providerToolNames).toEqual(providerToolNames);
    expect(rendererToolManifest.historyPolicy).toEqual({
      defaultMode: 'inspect-only',
      tools: historyTools,
    });
  });
});

describe('save_moclo_kit reusable schema contract', () => {
  it('advertises the exact nested schema accepted by the shared tool', () => {
    const advertised = manifestByName.get('save_moclo_kit')?.inputSchema.properties as
      | Record<string, unknown>
      | undefined;
    const enforced = asSchema(ALLOWED_RENDERER_TOOLS.save_moclo_kit.inputSchema).jsonSchema;
    expect(advertised?.assemblySchemas).toBeDefined();
    expect(advertised?.assemblySchemas).toEqual(enforced.properties?.assemblySchemas);
    for (const field of ['removeMemberPackageIds', 'removePartTypeIds', 'removeSchemaIds']) {
      expect(advertised?.[field]).toBeDefined();
      expect(advertised?.[field]).toEqual(enforced.properties?.[field]);
    }
  });
});

describe('create_reference nested identity contract', () => {
  it('advertises the type-specific coordinate fields enforced by the shared Zod factory', () => {
    const entry = manifestByName.get('create_reference');
    expect(entry, 'create_reference missing from manifest').toBeDefined();
    const topLevelProperties = entry?.inputSchema.properties as
      | Record<string, { properties?: Record<string, unknown> }>
      | undefined;
    const deepLinkProperties = topLevelProperties?.deepLinkParams?.properties;
    expect(Object.keys(deepLinkProperties ?? {}).sort()).toEqual([
      'bindingEnd',
      'bindingStart',
      'end',
      'featureName',
      'start',
      'wraps',
    ]);
    expect(
      (topLevelProperties?.selection as { description?: string } | undefined)?.description
    ).toContain('same staged entity unchanged');
    expect(
      (topLevelProperties?.selection as { description?: string } | undefined)?.description
    ).toContain('consistency assertion');
  });
});

function unwrapToZodObject(schema: z.ZodTypeAny): z.ZodObject<z.ZodRawShape> | null {
  let current: unknown = schema;
  for (let i = 0; i < 12; i += 1) {
    if (current instanceof z.ZodObject) return current as z.ZodObject<z.ZodRawShape>;
    const def = (current as { _def?: { typeName?: string; [k: string]: unknown } } | undefined)
      ?._def;
    if (!def || typeof def.typeName !== 'string') return null;
    switch (def.typeName) {
      case 'ZodEffects':
        current = def.schema;
        break;
      case 'ZodDefault':
      case 'ZodOptional':
      case 'ZodNullable':
      case 'ZodReadonly':
        current = def.innerType;
        break;
      case 'ZodBranded':
        current = def.type;
        break;
      case 'ZodPipeline':
        current = def.in;
        break;
      default:
        return null;
    }
  }
  return current instanceof z.ZodObject ? (current as z.ZodObject<z.ZodRawShape>) : null;
}

function visibleManifestProps(entry: ManifestEntry): Set<string> {
  const props = entry.inputSchema?.properties;
  return new Set(props && typeof props === 'object' ? Object.keys(props) : []);
}

const EXPECTED_SKIPPED_TOOLS: readonly string[] = [];

describe('Guard 1 — manifest param visibility across ALL advertised tools', () => {
  it('every top-level Zod param is a top-level manifest property the agent can call', () => {
    const covered: string[] = [];
    const skipped: string[] = [];
    const failures: string[] = [];

    for (const name of Object.keys(ALLOWED_RENDERER_TOOLS)) {
      const entry = manifestByName.get(name);
      if (!entry) {
        failures.push(`${name}: allowlisted but missing from manifest`);
        continue;
      }
      const zodObject = unwrapToZodObject(
        ALLOWED_RENDERER_TOOLS[name as keyof typeof ALLOWED_RENDERER_TOOLS].inputSchema
      );
      if (!zodObject) {
        skipped.push(name);
        continue;
      }
      covered.push(name);
      const visible = visibleManifestProps(entry);
      const missing = Object.keys(zodObject.shape).filter((k) => !visible.has(k));
      if (missing.length > 0) {
        failures.push(
          `${name}: Zod param(s) hidden from the CLI/MCP agent — not top-level manifest ` +
            `properties after the oneOf/anyOf/allOf strip: ${missing.join(', ')}`
        );
      }
    }

    expect(
      skipped.slice().sort(),
      'un-introspectable tools (must match EXPECTED_SKIPPED_TOOLS)'
    ).toEqual([...EXPECTED_SKIPPED_TOOLS].sort());
    expect(failures, 'params advertised by Zod but not reachable in the manifest').toEqual([]);

    expect(covered.length).toBe(
      Object.keys(ALLOWED_RENDERER_TOOLS).length - EXPECTED_SKIPPED_TOOLS.length
    );
  });

  it('no manifest tool hides a param inside a top-level oneOf/anyOf/allOf variant (the D1 shape)', () => {
    const offenders: string[] = [];
    for (const entry of manifestTools) {
      const schema = entry.inputSchema as Record<string, unknown>;
      const topLevelProps = visibleManifestProps(entry);
      for (const key of ['oneOf', 'anyOf', 'allOf'] as const) {
        const variants = schema[key];
        if (!Array.isArray(variants)) continue;
        for (const variant of variants) {
          const variantProps =
            variant &&
            typeof variant === 'object' &&
            (variant as { properties?: unknown }).properties;
          if (variantProps && typeof variantProps === 'object') {
            for (const prop of Object.keys(variantProps)) {
              if (!topLevelProps.has(prop)) {
                offenders.push(`${entry.name}.${key}[].${prop}`);
              }
            }
          }
        }
      }
    }
    expect(
      offenders,
      'params reachable only inside a top-level union variant (stripped at runtime)'
    ).toEqual([]);
  });

  it('every required manifest parameter is also an allowed top-level property', () => {
    const offenders: string[] = [];
    for (const entry of manifestTools) {
      const visible = visibleManifestProps(entry);
      const required = entry.inputSchema.required;
      if (!Array.isArray(required)) continue;
      for (const parameter of required) {
        if (typeof parameter === 'string' && !visible.has(parameter)) {
          offenders.push(`${entry.name}.${parameter}`);
        }
      }
    }

    expect(offenders, 'required inputs rejected by additionalProperties: false').toEqual([]);
  });
});

describe(' typed structure-selection parity', () => {
  it('advertises the same callable structure residue object on the CLI/MCP route', () => {
    const entry = manifestByName.get('create_reference');
    expect(entry).toBeDefined();
    const schema = entry?.inputSchema as {
      properties?: Record<string, unknown>;
    };
    const selection = schema.properties?.selection as
      | {
          anyOf?: Array<{
            required?: string[];
            properties?: {
              kind?: { const?: string };
              residues?: {
                items?: { required?: unknown; properties?: Record<string, unknown> };
              };
            };
          }>;
        }
      | undefined;
    const direct = selection?.anyOf?.find(
      (variant) => variant.properties?.kind?.const === 'structure'
    );
    const saved = selection?.anyOf?.find(
      (variant) => variant.properties?.kind?.const === 'saved_residue_selection'
    );
    expect(direct?.required).toEqual(['kind', 'structureRef', 'residues']);
    expect(saved?.required).toEqual(['kind', 'selectionId']);
    expect(direct?.properties?.residues?.items?.required).toEqual([
      'chain',
      'authSeqId',
      'labelCompId',
    ]);
    expect(Object.keys(direct?.properties?.residues?.items?.properties ?? {}).sort()).toEqual(
      [
        'authAsymId',
        'authSeqId',
        'baseChain',
        'chain',
        'compId',
        'entityId',
        'labelAsymId',
        'labelCompId',
        'labelSeqId',
        'operator',
      ].sort()
    );
    expect(entry?.requiresWorkspace).toBe(false);

    const runtime = ALLOWED_RENDERER_TOOLS.create_reference.inputSchema.safeParse({
      entityType: 'structure',
      displayLabel: '3OAA exact selection',
      selection: {
        kind: 'structure',
        structureRef: 'PDB:3OAA',
        residues: [
          { chain: 'A', authSeqId: 57, labelCompId: 'GLY' },
          { chain: 'A', authSeqId: 102, labelCompId: 'GLY' },
          { chain: 'A', authSeqId: 195, labelCompId: 'TYR' },
        ],
      },
    });
    expect(runtime.success).toBe(true);
    expect(
      ALLOWED_RENDERER_TOOLS.create_reference.inputSchema.safeParse({
        entityType: 'structure',
        displayLabel: 'Identity-incomplete structure selection',
        selection: {
          kind: 'structure',
          structureRef: 'PDB:3OAA',
          residues: [{ chain: 'A', authSeqId: 57 }],
        },
      }).success
    ).toBe(false);
    expect(
      ALLOWED_RENDERER_TOOLS.create_reference.inputSchema.safeParse({
        entityType: 'structure',
        displayLabel: 'Pinned catalytic selection',
        selection: {
          kind: 'saved_residue_selection',
          selectionId: 'selection-1',
          revisionId: 'selection-revision-1',
        },
      }).success
    ).toBe(true);
  });
});

describe(' open-tab digest authorization', () => {
  it.each(['virtual_digest', 'place_digest_fragment'])(
    '%s remains callable without a mounted workspace so its open-tab fallback is reachable',
    (toolName) => {
      expect(manifestByName.get(toolName)?.requiresWorkspace).toBe(false);
    }
  );
});

const routeB = new Set(Object.keys(ALLOWED_RENDERER_TOOLS));
const routeC = new Set(manifestTools.map((t) => t.name));

describe('Guard 2 — name parity (allowlist ⟺ manifest) by set difference', () => {
  it('Route B allowlist and the manifest advertise EXACTLY the same tool names', () => {
    const inAllowlistNotManifest = [...routeB].filter((n) => !routeC.has(n)).sort();
    const inManifestNotAllowlist = [...routeC].filter((n) => !routeB.has(n)).sort();
    expect(inAllowlistNotManifest, 'in ALLOWED_RENDERER_TOOLS but missing from manifest').toEqual(
      []
    );
    expect(inManifestNotAllowlist, 'in manifest but missing from ALLOWED_RENDERER_TOOLS').toEqual(
      []
    );
  });

  it('projects every renderer tool to one provider-safe, reversible Hosted name', () => {
    const rendererNames = Object.keys(ALLOWED_RENDERER_TOOLS) as RendererToolName[];
    const hostedNames = rendererNames.map(hostedToolNameForRenderer);

    expect(new Set(hostedNames).size).toBe(rendererNames.length);
    for (const [index, hostedName] of hostedNames.entries()) {
      expect(hostedName).toMatch(/^[A-Za-z0-9_-]{1,64}$/);
      expect(rendererToolNameForHosted(hostedName)).toBe(rendererNames[index]);
    }
    expect(hostedToolNameForRenderer('external.fetch')).toBe('external_fetch');
    expect(hostedToolNameForRenderer('external.xref')).toBe('external_xref');
    expect(rendererToolNameForHosted('external.fetch')).toBeNull();
  });
});

const TOOL_EFFECTS = new Set(['read-only', 'mutating', 'ui-bound', 'external-submit']);
const TOOL_SHAPES = new Set(['app-action', 'data-service', 'adapter', 'viz-tab-action']);

const READ_ISH_CAPS = new Set([
  'read-workspace',
  'read-sequences',
  'operations.read',
  'external-fetch:xref-resolution',
  'external-fetch:structure',
  'external-fetch:paper',
  'external-compute:tm',

  'external-compute:discover',
]);
const WRITE_ISH_CAPS = new Set([
  'operations.start',
  'create-entity',
  'edit-assembly',
  'edit-primers',
  'edit-protocols',
  'finalize-protocol',
  'write-workspace',
  'finalize-assembly',
  'modify-tabs',
  'modify-settings',
  'manage-agent-access',
  'submit-feedback',
  'external-fetch:annotation',

  'external-compute:submit',
  'external-compute:manage',
]);

const EXTERNAL_SUBMIT_CAPS = new Set(['external-compute:submit']);

const HUMAN_DECIDED_EXTERNAL_TOOLS = new Set(['administration']);

const MUTATION_CAPS = new Set([
  'operations.start',
  'create-entity',
  'edit-assembly',
  'edit-primers',
  'edit-protocols',
  'finalize-protocol',
  'write-workspace',
  'finalize-assembly',
  'modify-settings',
  'manage-agent-access',
  'submit-feedback',
  'external-fetch:annotation',

  'external-compute:manage',
]);

const WORKSPACE_DATA_CAPS = new Set([
  'read-sequences',
  'read-workspace',
  'create-entity',
  'edit-assembly',
  'edit-primers',
  'edit-protocols',
  'finalize-protocol',
  'write-workspace',
  'finalize-assembly',
]);

describe('Guard 3 — capability metadata is internally consistent (auth-gating surface)', () => {
  it('keeps remote BigWig admission unconditional on both UI and external-fetch authority', () => {
    const entry = manifestTools.find((tool) => tool.name === 'add_indexed_bigwig_url');

    expect(entry?.required_capabilities).toEqual(['modify-tabs', 'external-fetch:annotation']);
    expect(entry?.conditional_required_capabilities ?? []).toEqual([]);
    expect(ALLOWED_RENDERER_TOOLS.add_indexed_bigwig_url.required_capabilities).toEqual(
      entry?.required_capabilities
    );
  });

  it('READ_ISH and WRITE_ISH partition every capability the manifest uses (new caps must be classified)', () => {
    const overlap = [...READ_ISH_CAPS].filter((c) => WRITE_ISH_CAPS.has(c));
    expect(overlap, 'a capability cannot be both read-ish and write-ish').toEqual([]);
    const classified = new Set([...READ_ISH_CAPS, ...WRITE_ISH_CAPS]);
    const usedButUnclassified = [
      ...new Set(
        manifestTools.flatMap((t) => [
          ...t.required_capabilities,
          ...(t.conditional_required_capabilities ?? []),
        ])
      ),
    ]
      .filter((c) => !classified.has(c))
      .sort();
    expect(
      usedButUnclassified,
      'capabilities used in the manifest but not classified read-ish/write-ish'
    ).toEqual([]);
  });

  for (const entry of manifestTools) {
    describe(entry.name, () => {
      const effects = new Set(entry.effects);
      const caps = new Set(entry.required_capabilities);
      const conditionalCaps = new Set(entry.conditional_required_capabilities ?? []);
      const declaredCaps = new Set([...caps, ...conditionalCaps]);

      it('shape/effects/capabilities use only known vocabulary and are non-empty', () => {
        expect(TOOL_SHAPES.has(entry.shape), `unknown shape "${entry.shape}"`).toBe(true);
        expect(entry.effects.length, 'effects must be non-empty').toBeGreaterThan(0);
        expect(
          entry.required_capabilities.length,
          'required_capabilities must be non-empty'
        ).toBeGreaterThan(0);
        expect(
          entry.effects.filter((e) => !TOOL_EFFECTS.has(e)),
          'unknown effect value(s)'
        ).toEqual([]);
        expect(
          [
            ...entry.required_capabilities,
            ...(entry.conditional_required_capabilities ?? []),
          ].filter((c) => !READ_ISH_CAPS.has(c) && !WRITE_ISH_CAPS.has(c)),
          'unknown/unclassified capability value(s)'
        ).toEqual([]);
      });

      it('conditional requirements are disjoint, declared, and backed by an input resolver', () => {
        expect(
          [...conditionalCaps].filter((capability) => caps.has(capability)),
          'conditional capabilities must not duplicate the static manifest floor'
        ).toEqual([]);
        const definition =
          ALLOWED_RENDERER_TOOLS[entry.name as keyof typeof ALLOWED_RENDERER_TOOLS];
        expect(definition.conditional_required_capabilities).toEqual([...conditionalCaps]);
        expect(definition.conditionallyRequiresWorkspace).toBe(
          entry.conditionallyRequiresWorkspace ?? false
        );
        if (conditionalCaps.size > 0 || entry.conditionallyRequiresWorkspace) {
          expect(definition.resolveInputAuthorization).toEqual(expect.any(Function));
        } else {
          expect(definition.resolveInputAuthorization).toBeUndefined();
        }
        if (entry.conditionallyRequiresWorkspace) {
          expect(
            [...conditionalCaps].some((capability) => WORKSPACE_DATA_CAPS.has(capability)),
            'conditional workspace access requires a conditional workspace-data capability'
          ).toBe(true);
        }
      });

      it("a 'ui-bound' tool declares the modify-tabs capability", () => {
        if (effects.has('ui-bound')) {
          expect(
            declaredCaps.has('modify-tabs'),
            'ui-bound effect requires a declared modify-tabs capability'
          ).toBe(true);
        }
      });

      it("a 'mutating' tool declares a write/persist capability", () => {
        if (effects.has('mutating')) {
          const hasMutationCap = [...declaredCaps].some((c) => MUTATION_CAPS.has(c));
          expect(
            hasMutationCap,
            `mutating effect requires one of ${[...MUTATION_CAPS].join(', ')}; has ${[...caps].join(', ')}`
          ).toBe(true);
        }
      });

      it("an 'external-submit' tool declares the compute submit capability, and vice versa", () => {
        const declaresSubmitCap = [...caps].some((c) => EXTERNAL_SUBMIT_CAPS.has(c));
        if (HUMAN_DECIDED_EXTERNAL_TOOLS.has(entry.name)) {
          expect(effects.has('external-submit')).toBe(true);
          expect(declaresSubmitCap).toBe(false);
          expect(entry.audit_required).toBe(true);
          expect(entry.sidecarOrchestrated).toBe(true);
          return;
        }
        expect(effects.has('external-submit')).toBe(declaresSubmitCap);
      });

      it('a pure read-only tool holds NO write-ish capability (under-gating guard)', () => {
        const pureReadOnly =
          effects.has('read-only') && !effects.has('mutating') && !effects.has('ui-bound');
        if (pureReadOnly) {
          const leakedWriteCaps = [...caps].filter((c) => WRITE_ISH_CAPS.has(c));
          expect(
            leakedWriteCaps,
            'read-only tool must not require a write-ish capability (mislabeled effects?)'
          ).toEqual([]);
        }
      });

      it('declares an explicit workspace-grounding policy independent of authorization', () => {
        const pureReadOnly =
          effects.has('read-only') && !effects.has('mutating') && !effects.has('ui-bound');
        if (!pureReadOnly) {
          if (entry.workspaceGrounding === 'when-existing-reference') {
            expect(
              visibleManifestProps(entry).has('selection'),
              'when-existing-reference grounding requires an advertised selection input'
            ).toBe(true);
          } else if (entry.workspaceGrounding !== undefined) {
            expect(['always', 'none']).toContain(entry.workspaceGrounding);
            expect(entry.requiresWorkspace).toBe(entry.workspaceGrounding === 'always');
          }
          return;
        }
        expect(['always', 'when-ref-id', 'when-workspace-file', 'none']).toContain(
          entry.workspaceGrounding
        );
        if (entry.workspaceGrounding === 'when-workspace-file') {
          expect(entry.name).toBe('read_file');
          expect(visibleManifestProps(entry).has('path')).toBe(true);
        }
        if (entry.workspaceGrounding === 'when-ref-id') {
          expect(
            visibleManifestProps(entry).has('refId'),
            'when-ref-id grounding requires an advertised refId input'
          ).toBe(true);
        }
      });

      it("shape 'viz-tab-action' implies a ui-bound effect", () => {
        if (entry.shape === 'viz-tab-action') {
          expect(effects.has('ui-bound'), 'viz-tab-action is a UI mutation').toBe(true);
        }
      });

      it("shape 'app-action' implies a mutating effect", () => {
        if (entry.shape === 'app-action') {
          expect(effects.has('mutating'), 'app-action mutates app state').toBe(true);
        }
      });

      it('requiresWorkspace is a boolean, and if true the tool holds a workspace-data capability', () => {
        expect(typeof entry.requiresWorkspace, 'requiresWorkspace must be a boolean').toBe(
          'boolean'
        );
        if (entry.requiresWorkspace) {
          const hasWorkspaceCap = [...caps].some((c) => WORKSPACE_DATA_CAPS.has(c));
          expect(
            hasWorkspaceCap,
            `requiresWorkspace:true but no workspace-data capability (${[...caps].join(', ')})`
          ).toBe(true);
        }
      });
    });
  }
});

describe('Guard 4 — manifest advertises no phantom param absent from the Zod SSOT ', () => {
  it('every top-level manifest property is a real Zod param the runtime accepts', () => {
    const failures: string[] = [];
    const skipped: string[] = [];
    let covered = 0;
    for (const name of Object.keys(ALLOWED_RENDERER_TOOLS)) {
      const entry = manifestByName.get(name);
      if (!entry) {
        failures.push(`${name}: allowlisted but missing from manifest`);
        continue;
      }
      const zodObject = unwrapToZodObject(
        ALLOWED_RENDERER_TOOLS[name as keyof typeof ALLOWED_RENDERER_TOOLS].inputSchema
      );
      if (!zodObject) {
        skipped.push(name);
        continue;
      }
      covered += 1;
      const zodParams = new Set(Object.keys(zodObject.shape));
      const phantom = [...visibleManifestProps(entry)].filter((k) => !zodParams.has(k)).sort();
      if (phantom.length > 0) {
        failures.push(
          `${name}: manifest advertises top-level param(s) with no Zod backing — the manifest ` +
            `name surface has drifted from the factory Zod SSOT. The runtime validates input ` +
            `against that Zod (callRendererTool → inputSchema.safeParse, renderer-bridge.ts), so a ` +
            `phantom param is STRIPPED (default schema) or REJECTED as BAD_INPUT (a .strict() ` +
            `schema like import_sequence) — never honored as advertised: ${phantom.join(', ')}`
        );
      }
    }
    expect(failures, 'phantom manifest params (advertised to the agent, no Zod backing)').toEqual(
      []
    );

    expect(
      skipped.slice().sort(),
      'un-introspectable tools (must match EXPECTED_SKIPPED_TOOLS)'
    ).toEqual([...EXPECTED_SKIPPED_TOOLS].sort());
    expect(covered).toBe(
      Object.keys(ALLOWED_RENDERER_TOOLS).length - EXPECTED_SKIPPED_TOOLS.length
    );
  });
});

describe('external SDK output-schema compatibility', () => {
  const validator = new AjvJsonSchemaValidator();
  for (const entry of rendererToolManifest.tools) {
    it(`compiles ${entry.name} with the actual MCP client validator`, () => {
      expect(() => validator.getValidator(entry.outputSchema)).not.toThrow();
    });
  }
});
