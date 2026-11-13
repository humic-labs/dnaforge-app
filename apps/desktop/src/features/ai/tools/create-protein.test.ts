import { createProteinOutputSchema } from './protein-output-schemas';
import { assertMcpOutput } from '../../../test-utils/mcp-output-test-helper';
import { describe, expect, it, vi } from 'vitest';
import type { WorkspaceFolder } from '../../../stores/workspaceStore';
import { execTool as executeTool } from './test-helpers';
import {
  createCreateProteinTool,
  createProteinSchema,
  type CreateProteinDependencies,
} from './create-protein';

const singleWorkspace: WorkspaceFolder[] = [
  { name: 'project', path: '/workspace/project', addedAt: 1 },
];

function dependencies(): CreateProteinDependencies {
  return {
    recordProtein: vi.fn(async () => ({
      artifactPath: 'proteins/Agent-protein-12345678.entity.json',
      limsEntity: {
        id: 'protein-1234',
        kind: 'protein',
        name: 'Agent protein',
      },
      gitCommitted: true,
    })),
  } as CreateProteinDependencies;
}

describe('create_protein tool', () => {
  it('uses the file-authoritative protein writer and normalizes the sequence', async () => {
    const deps = dependencies();
    const tool = createCreateProteinTool(singleWorkspace, deps);

    const result = await execTool<{
      changed: boolean;
      proteinId: string;
      artifactPath: string;
      sequenceLength: number;
      gitCommitted: boolean;
    }>(tool, {
      name: 'Agent protein',
      sequence: 'mkki gysarx*',
      destinationPath: 'derived/proteins',
      organism: 'Escherichia coli',
      sourceCds: 'sequences/source.entity.json#cds-1',
      notes: 'Created through the shared agent tool.',
    });

    expect(deps.recordProtein).toHaveBeenCalledWith({
      name: 'Agent protein',
      sequence: 'MKKIGYSARX*',
      workspaceRoot: '/workspace/project',
      dir: '/workspace/project/derived/proteins',
      organism: 'Escherichia coli',
      sourceCds: 'sequences/source.entity.json#cds-1',
      notes: 'Created through the shared agent tool.',
      actor: 'agent',
    });
    expect(result).toEqual({
      ok: true,
      changed: true,
      proteinId: 'protein-1234',
      name: 'Agent protein',
      sequenceLength: 11,
      artifactPath: 'proteins/Agent-protein-12345678.entity.json',
      registryEntityId: 'protein-1234',
      gitCommitted: true,
    });
  });

  it('fails closed on invalid amino-acid input before calling the writer', async () => {
    const deps = dependencies();
    const result = await execTool<{ changed: boolean; code: string; message: string }>(
      createCreateProteinTool(singleWorkspace, deps),
      { name: 'Invalid', sequence: 'MAZ' }
    );

    expect(result.changed).toBe(false);
    expect(result.code).toBe('PROTEIN_MUTATION_FAILED');
    expect(result.message).toMatch(/standard one-letter amino-acid codes/i);
    expect(deps.recordProtein).not.toHaveBeenCalled();
  });

  it('rejects paths outside the selected workspace', async () => {
    const deps = dependencies();
    const result = await execTool<{ changed: boolean; message: string }>(
      createCreateProteinTool(singleWorkspace, deps),
      { name: 'Escape', sequence: 'MKT', destinationPath: '../outside' }
    );

    expect(result.changed).toBe(false);
    expect(result.message).toMatch(/escapes project boundary/i);
    expect(deps.recordProtein).not.toHaveBeenCalled();
  });

  it('requires an explicit workspace only when more than one user workspace is open', async () => {
    const deps = dependencies();
    const folders: WorkspaceFolder[] = [
      ...singleWorkspace,
      { name: 'second', path: '/workspace/second', addedAt: 2 },
    ];
    const missing = await execTool<{ changed: boolean; message: string }>(
      createCreateProteinTool(folders, deps),
      { name: 'Ambiguous', sequence: 'MKT' }
    );
    expect(missing.message).toMatch(/multiple projects/i);

    await execTool(createCreateProteinTool(folders, deps), {
      name: 'Second protein',
      sequence: 'MKT',
      workspace: 'second',
    });
    expect(deps.recordProtein).toHaveBeenLastCalledWith(
      expect.objectContaining({
        workspaceRoot: '/workspace/second',
        dir: '/workspace/second/proteins',
      })
    );
  });

  it('refuses duplicate project display names instead of writing to the first', async () => {
    const deps = dependencies();
    const result = await execTool<{ changed: boolean; message: string }>(
      createCreateProteinTool(
        [
          { name: 'Shared', path: '/projects/first', addedAt: 1 },
          { name: 'Shared', path: '/projects/second', addedAt: 2 },
        ],
        deps
      ),
      { name: 'Ambiguous', sequence: 'MKT', workspace: 'Shared' }
    );

    expect(result.changed).toBe(false);
    expect(result.message).toMatch(/not found/i);
    expect(deps.recordProtein).not.toHaveBeenCalled();
  });

  it('keeps every callable parameter visible in the full route schema', () => {
    expect(Object.keys(createProteinSchema.shape)).toEqual([
      'name',
      'sequence',
      'destinationPath',
      'workspace',
      'organism',
      'sourceCds',
      'notes',
    ]);
  });
});

async function execTool<T>(...args: Parameters<typeof executeTool>): Promise<T> {
  const result = await executeTool<T>(...args);
  if (result && typeof result === 'object' && 'ok' in result && result.ok === true)
    assertMcpOutput(createProteinOutputSchema, result);
  return result;
}
