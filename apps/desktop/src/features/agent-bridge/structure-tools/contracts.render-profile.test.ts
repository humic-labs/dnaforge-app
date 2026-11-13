import { asSchema } from 'ai';
import { describe, expect, it } from 'vitest';
import rendererToolManifest from '../../../../../../packages/core/agent-tools/renderer-tool-manifest.json';
import {
  DEFAULT_MOLECULAR_RENDER_PROFILE,
  molecularRenderProfileSelectionSchema,
} from '../../page/public/embeds/structure3d/molstar/molecularRenderProfile';
import { molApplySceneSchema } from './contracts';

describe('MCP scene render-profile contract', () => {
  it('accepts a bare standard root only through explicit root authoring', () => {
    const root = { kind: 'root', children: [] };
    expect(molApplySceneSchema.parse({ structureViewId: 'view', root }).root).toEqual(root);
    expect(molApplySceneSchema.safeParse({ structureViewId: 'view' }).success).toBe(false);
    for (const renderProfile of ['native', DEFAULT_MOLECULAR_RENDER_PROFILE]) {
      expect(
        molApplySceneSchema.safeParse({ structureViewId: 'view', scene: '{}', renderProfile })
          .success
      ).toBe(false);
    }
    expect(
      molApplySceneSchema.safeParse({ structureViewId: 'view', root, scene: '{}' }).success
    ).toBe(false);
    const advertised = rendererToolManifest.tools.find(
      (tool) => tool.name === 'mol_apply_scene'
    )!.inputSchema;
    expect(advertised.properties).toHaveProperty('root');
    expect(advertised.required ?? []).not.toContain('scene');
  });
  it('advertises the complete render-profile schema at the callable MCP property', () => {
    const advertised = rendererToolManifest.tools.find((tool) => tool.name === 'mol_apply_scene')!
      .inputSchema.properties as Record<string, unknown>;
    const enforced = asSchema(molApplySceneSchema).jsonSchema.properties as Record<string, unknown>;
    expect(advertised.renderProfile).toBeDefined();
    expect(advertised.renderProfile).toEqual(enforced.renderProfile);
  });

  it('accepts the canonical agent profile and rejects appearance bypasses', () => {
    for (const renderProfile of ['default']) {
      const input = { structureViewId: 'view', scene: '{}', renderProfile };
      expect(molApplySceneSchema.parse(input).renderProfile).toEqual(
        molecularRenderProfileSelectionSchema.parse(renderProfile)
      );
    }
    expect(
      molApplySceneSchema.safeParse({
        structureViewId: 'view',
        scene: '{}',
        renderProfile: {
          ...DEFAULT_MOLECULAR_RENDER_PROFILE,
          ballAndStick: { ...DEFAULT_MOLECULAR_RENDER_PROFILE.ballAndStick, bondToAtomRatio: -1 },
        },
      }).success
    ).toBe(false);
    expect(
      molApplySceneSchema.safeParse({
        structureViewId: 'view',
        scene: '{}',
        renderProfile: { ...DEFAULT_MOLECULAR_RENDER_PROFILE, unsupported: true },
      }).success
    ).toBe(false);
  });
});
