import { execDesignContract } from '../../../test-utils/design-output-test-helper';
import {
  inspectHistoricalAssemblyStageTargetOutputSchema,
  listHistoricalAssemblyComponentsOutputSchema,
  previewHistoricalAssemblyComponentStageOutputSchema,
  stageHistoricalAssemblyComponentsOutputSchema,
} from './design-output-schemas';
import { describe, expect, it, vi } from 'vitest';
import type { ResolvedAcceptedAssemblyRecord } from '../../assembly/public/accepted-record-reader';
import type { HistoricalAssemblyComponent } from '../../assembly/public/historical-component-composition';
import {
  createInspectHistoricalAssemblyStageTargetTool,
  createListHistoricalAssemblyComponentsTool,
  createPreviewHistoricalAssemblyComponentStageTool,
  createStageHistoricalAssemblyComponentsTool,
  stageHistoricalAssemblyComponentsSchema,
} from './sequence-assembly-history-components';

const folders = [{ path: '/workspace', name: 'Workspace', addedAt: 0 }];
const source: HistoricalAssemblyComponent = {
  kind: 'region',
  acceptedAssemblyVersionId: 'accepted-old',
  canonicalDraftChecksum: 'sha256:older-canonical-record',
  componentId: '["region","left"]',
  componentDigest: `sha256:${'a'.repeat(64)}`,
  regionId: 'left',
};
const selection = { source, target: { kind: 'region' as const, regionId: 'left' } };
const target = {
  constructId: 'construct-one',
  baseAcceptedAssemblyVersionId: 'accepted-current',
  exists: true,
  designId: 'owned-design',
  designVersion: 4,
  draftDigest: `sha256:${'b'.repeat(64)}`,
  draftPath: '/workspace/pkg/.forge/draft.json',
  targets: [selection.target],
};

function dependencies() {
  return {
    resolve: vi.fn(
      async () => ({ packageRoot: '/workspace/pkg' }) as ResolvedAcceptedAssemblyRecord
    ),
    list: vi.fn(async () => ({ components: [source], unavailable: [] })),
    inspect: vi.fn(async () => target),
    preview: vi.fn(async () => ({ status: 'ready' as const, target, nextDesignVersion: 5 })),
    stage: vi.fn(async () => ({
      constructId: 'construct-one',
      designId: 'owned-design',
      designVersion: 5,
      draftPath: target.draftPath,
      stagedCount: 1,
    })),
  };
}

const options = { toolCallId: 'test-call', messages: [] };

async function execute(value: { execute?: (...args: any[]) => any }, input: unknown) {
  if (!value.execute) throw new Error('Tool has no execute function.');
  return value.execute(input, options);
}

describe('historical assembly component agent tools', () => {
  it('exposes exact saved source pins and draft target without local paths', async () => {
    const deps = dependencies();
    const listed = await execDesignContract(
      listHistoricalAssemblyComponentsOutputSchema,
      createListHistoricalAssemblyComponentsTool(folders, deps),
      {
        constructId: 'construct-one',
      }
    );
    const inspected = await execDesignContract(
      inspectHistoricalAssemblyStageTargetOutputSchema,
      createInspectHistoricalAssemblyStageTargetTool(folders, deps),
      {
        constructId: 'construct-one',
        baseAcceptedAssemblyVersionId: 'accepted-current',
      }
    );
    expect(listed).toMatchObject({ ok: true, total: 1, components: [source] });
    expect(inspected).toMatchObject({ ok: true, designVersion: 4, targets: [selection.target] });
    expect(JSON.stringify([listed, inspected])).not.toContain('/workspace/pkg');
  });

  it('previews before stage and stage sends the exact pins to the shared owner', async () => {
    const deps = dependencies();
    const input = {
      constructId: 'construct-one',
      baseAcceptedAssemblyVersionId: 'accepted-current',
      expectedDesignVersion: 4,
      expectedDraftDigest: target.draftDigest,
      selections: [selection],
    };
    expect(
      stageHistoricalAssemblyComponentsSchema.safeParse({
        ...input,
        reopenIdempotencyKey: 'stage-once',
      }).success
    ).toBe(true);
    const preview = await execDesignContract(
      previewHistoricalAssemblyComponentStageOutputSchema,
      createPreviewHistoricalAssemblyComponentStageTool(folders, deps),
      input
    );
    expect(preview).toMatchObject({ ok: true, status: 'ready', nextDesignVersion: 5 });
    expect(JSON.stringify(preview)).not.toContain(target.draftPath);
    const staged = await execDesignContract(
      stageHistoricalAssemblyComponentsOutputSchema,
      createStageHistoricalAssemblyComponentsTool(folders, deps),
      {
        ...input,
        reopenIdempotencyKey: 'stage-once',
      }
    );
    expect(staged).toMatchObject({ ok: true, designVersion: 5, stagedCount: 1 });
    expect(JSON.stringify(staged)).not.toContain(target.draftPath);
    expect(deps.stage).toHaveBeenCalledWith({
      ...input,
      reopenIdempotencyKey: 'stage-once',
      actor: 'agent',
    });
  });

  it('refuses an assembly outside the open project before staging', async () => {
    const deps = dependencies();
    deps.resolve.mockResolvedValue({
      packageRoot: '/another-workspace/pkg',
    } as ResolvedAcceptedAssemblyRecord);
    const result = await execDesignContract(
      stageHistoricalAssemblyComponentsOutputSchema,
      createStageHistoricalAssemblyComponentsTool(folders, deps),
      {
        constructId: 'construct-one',
        baseAcceptedAssemblyVersionId: 'accepted-current',
        expectedDesignVersion: 4,
        expectedDraftDigest: target.draftDigest,
        selections: [selection],
        reopenIdempotencyKey: 'stage-once',
      }
    );
    expect(result).toMatchObject({ ok: false, stateChanged: false });
    expect(deps.stage).not.toHaveBeenCalled();
  });

  it('reports an uncertain partial effect if staging fails after entering the writer', async () => {
    const deps = dependencies();
    deps.stage.mockRejectedValue(new Error('The working copy changed during staging.'));
    const result = await execDesignContract(
      stageHistoricalAssemblyComponentsOutputSchema,
      createStageHistoricalAssemblyComponentsTool(folders, deps),
      {
        constructId: 'construct-one',
        baseAcceptedAssemblyVersionId: 'accepted-current',
        expectedDesignVersion: 4,
        expectedDraftDigest: target.draftDigest,
        selections: [selection],
        reopenIdempotencyKey: 'stage-once',
      }
    );
    expect(result).toMatchObject({
      ok: false,
      stateChanged: 'unknown',
      partialEffects: ['package-owned assembly copy may have been opened'],
    });
  });
});
