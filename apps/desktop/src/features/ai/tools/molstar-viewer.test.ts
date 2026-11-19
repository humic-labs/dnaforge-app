import { describe, expect, it, vi } from 'vitest';

import { execTool } from './test-helpers';
import {
  createMolFocusTool,
  createMolGetStateTool,
  createMolListStructuresTool,
  createMolSelectResiduesTool,
  createMolSetColorTool,
  createMolSetRepresentationTool,
  createMolSetSideChainsTool,
  type MolstarViewerToolDependencies,
} from './molstar-viewer';

function dependencies(): MolstarViewerToolDependencies {
  return {
    listStructures: vi.fn().mockResolvedValue({ ok: true, structures: [] }),
    getState: vi.fn().mockResolvedValue({ ok: true, structures: [{ viewerId: 'viewer:3OAA' }] }),
    selectResidues: vi.fn().mockResolvedValue({ ok: true, selection: 'chain A and resi 57' }),
    setRepresentation: vi.fn().mockResolvedValue({ ok: true, representation: 'surface' }),
    setColor: vi.fn().mockResolvedValue({ ok: true, colorMode: 'chain' }),
    setSideChains: vi.fn().mockResolvedValue({ ok: true, visible: true }),
    focus: vi.fn().mockResolvedValue({ ok: true, focused: true }),
  };
}

describe('shared Mol* viewer tools', () => {
  it('delegates every hosted/CLI tool factory to the existing viewer handler exactly once', async () => {
    const deps = dependencies();
    const calls = [
      [createMolListStructuresTool(deps), { detail: 'full' }, deps.listStructures],
      [createMolGetStateTool(deps), { viewerId: 'viewer:3OAA' }, deps.getState],
      [
        createMolSelectResiduesTool(deps),
        { viewerId: 'viewer:3OAA', selection: 'chain A and resi 57' },
        deps.selectResidues,
      ],
      [
        createMolSetRepresentationTool(deps),
        { viewerId: 'viewer:3OAA', representation: 'surface' },
        deps.setRepresentation,
      ],
      [
        createMolSetColorTool(deps),
        { viewerId: 'viewer:3OAA', colorMode: 'chain' },
        deps.setColor,
      ],
      [
        createMolSetSideChainsTool(deps),
        { viewerId: 'viewer:3OAA', target: 'selection', visible: true },
        deps.setSideChains,
      ],
      [
        createMolFocusTool(deps),
        { viewerId: 'viewer:3OAA', selection: 'chain A and resi 57' },
        deps.focus,
      ],
    ] as const;

    for (const [viewerTool, input, handler] of calls) {
      await execTool(viewerTool, input);
      expect(handler).toHaveBeenCalledTimes(1);
      expect(handler).toHaveBeenCalledWith(input);
    }
  });

  it('keeps scene-changing tools explicit in their descriptions', () => {
    const deps = dependencies();
    for (const viewerTool of [
      createMolSelectResiduesTool(deps),
      createMolSetRepresentationTool(deps),
      createMolSetColorTool(deps),
      createMolSetSideChainsTool(deps),
      createMolFocusTool(deps),
    ]) {
      expect(viewerTool.description).toMatch(/only when the user/i);
    }
  });
});
