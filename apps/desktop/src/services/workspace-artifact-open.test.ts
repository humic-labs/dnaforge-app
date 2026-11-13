import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  planWorkspaceArtifactRepair: vi.fn(),
  applyAcceptedWorkspaceArtifactRepair: vi.fn(),
  resolveArtifactFile: vi.fn(),
  withRendererWorkspaceMutation: vi.fn(),
}));

vi.mock('../db/workspace-artifacts', () => ({
  planWorkspaceArtifactRepair: h.planWorkspaceArtifactRepair,
  applyAcceptedWorkspaceArtifactRepair: h.applyAcceptedWorkspaceArtifactRepair,
  resolveArtifactFile: h.resolveArtifactFile,
}));

vi.mock('./workspace-mutation-transaction', () => ({
  withRendererWorkspaceMutation: h.withRendererWorkspaceMutation,
}));

import { withWorkspaceArtifactOpen } from './workspace-artifact-open';

const resolvedArtifact = {
  entity: {
    id: 'design-1',
    type: 'design',
    name: 'Design 1',
    locator: 'entity://design/design-1',
    storage_type: 'localStorage',
    status: 'active',
    workspace_id: 1,
    metadata: null,
    created_at: 1,
    updated_at: 1,
  },
  artifact: {
    schema: 'waypoint.design.v1',
    kind: 'assembly-design',
    id: 'design-1',
    name: 'Design 1',
    design: null,
    raw: {},
  },
  repaired: true,
  authorityFingerprint: 'authority-fingerprint-1',
} as const;

describe('withWorkspaceArtifactOpen', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    h.withRendererWorkspaceMutation.mockImplementation(
      async (
        _workspaceRoot: string | null,
        operation: (mutationToken?: string) => Promise<unknown>
      ) => operation('mutation-token-1')
    );
    h.resolveArtifactFile.mockResolvedValue(resolvedArtifact);
  });

  it('holds one mutation token through repair and renderer publication', async () => {
    const repairPlan = {
      kind: 'catalog-recovery',
      path: '/workspace/a/design.wpdesign.json',
      workspaceRoot: '/workspace/a',
      artifact: resolvedArtifact.artifact,
      entityId: 'design-1',
      afterPath: '/workspace/a/design.wpdesign.json',
      confidence: 'confirmed',
      evidence: { source: 'test' },
    } as const;
    h.planWorkspaceArtifactRepair.mockResolvedValue(repairPlan);
    h.applyAcceptedWorkspaceArtifactRepair.mockResolvedValue(resolvedArtifact);
    const consume = vi.fn(async () => 'opened');

    await expect(
      withWorkspaceArtifactOpen({
        path: repairPlan.path,
        workspaceRoot: repairPlan.workspaceRoot,
        consume,
      })
    ).resolves.toBe('opened');

    expect(h.planWorkspaceArtifactRepair).toHaveBeenCalledWith({
      path: repairPlan.path,
      workspaceRoot: repairPlan.workspaceRoot,
      mutationToken: 'mutation-token-1',
    });
    expect(h.applyAcceptedWorkspaceArtifactRepair).toHaveBeenCalledWith(
      repairPlan,
      'mutation-token-1'
    );
    expect(h.resolveArtifactFile).toHaveBeenCalledWith({
      path: repairPlan.path,
      workspaceRoot: repairPlan.workspaceRoot,
      mutationToken: 'mutation-token-1',
    });
    expect(consume).toHaveBeenCalledWith(resolvedArtifact, 'mutation-token-1');
    expect(h.withRendererWorkspaceMutation).toHaveBeenCalledWith(
      '/workspace/a',
      expect.any(Function),
      undefined,
      { waitForAvailability: true }
    );
  });

  it('reuses the outer mutation token while reading an already-current artifact', async () => {
    const path = '/workspace/a/design.wpdesign.json';
    h.planWorkspaceArtifactRepair.mockResolvedValue({
      kind: 'no-op',
      path,
      workspaceRoot: '/workspace/a',
      artifact: resolvedArtifact.artifact,
      entityId: 'design-1',
      reason: 'already-current',
    });
    h.resolveArtifactFile.mockResolvedValue(resolvedArtifact);

    await expect(
      withWorkspaceArtifactOpen({
        path,
        workspaceRoot: '/workspace/a',
        consume: async () => 'opened',
      })
    ).resolves.toBe('opened');

    expect(h.resolveArtifactFile).toHaveBeenCalledWith({
      path,
      workspaceRoot: '/workspace/a',
      mutationToken: 'mutation-token-1',
    });
  });

  it('refuses a conflicting artifact before consuming renderer state', async () => {
    h.planWorkspaceArtifactRepair.mockResolvedValue({
      kind: 'conflict',
      path: '/workspace/a/design.wpdesign.json',
      workspaceRoot: '/workspace/a',
      artifact: resolvedArtifact.artifact,
      entityId: 'design-1',
      conflictingEntityId: 'design-2',
      reason: 'path-bound-to-different-entity',
      evidence: {},
    });
    const consume = vi.fn(async () => undefined);

    await expect(
      withWorkspaceArtifactOpen({
        path: '/workspace/a/design.wpdesign.json',
        workspaceRoot: '/workspace/a',
        consume,
      })
    ).rejects.toThrow('path-bound-to-different-entity');
    expect(h.applyAcceptedWorkspaceArtifactRepair).not.toHaveBeenCalled();
    expect(h.resolveArtifactFile).not.toHaveBeenCalled();
    expect(consume).not.toHaveBeenCalled();
  });
});
