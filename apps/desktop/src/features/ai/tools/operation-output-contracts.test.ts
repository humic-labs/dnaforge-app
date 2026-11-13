import { beforeEach, describe, expect, it, vi } from 'vitest';
import nativeOutput from './fixtures/native-annotation-output.json';

const stat = vi.hoisted(() => vi.fn());
vi.mock('../../../platform', () => ({ platform: () => ({ fs: { stat } }) }));

import {
  createPrepareManagedTrackRegistrationTool,
  managedTrackRegistrationStartSchema,
} from './track-registration-operation';
import {
  createInspectManagedAnnotationOperationTool,
  createApplyManagedAnnotationOperationTool,
} from './managed-annotation-operation';
import {
  operationsAnnotationApplyOutputSchema,
  operationsAnnotationInspectOutputSchema,
  operationsTrackRegistrationStartOutputSchema,
} from './operation-output-schemas';
import { assertMcpOutput } from '../../../test-utils/mcp-output-test-helper';
import { assertToolOperationResult } from '../../agent-bridge/public/tool-result';

const folders = [{ path: '/workspace', name: 'Project', addedAt: 1 }];
const options = { toolCallId: 'operation-contract', messages: [] };
const registration = {
  path: 'promoters.gff3',
  accession: 'NC_000913.3',
  lengthBp: 4_641_652,
  name: 'observed-promoters',
  kinds: ['promoter'],
  label: 'Observed promoters',
  evidence: 'measured',
  licenseAttribution: 'Example dataset attribution',
  aliases: ['U00096.3'],
};

beforeEach(() => {
  vi.clearAllMocks();
  stat.mockImplementation(async (path: string) => ({
    canonicalPath: path,
    isFile: path !== '/workspace',
    isDirectory: path === '/workspace',
  }));
});

describe('managed operation output contracts', () => {
  it('validates the real canonical track preparation and rejects invalid feature kinds', async () => {
    const tool = createPrepareManagedTrackRegistrationTool(folders);
    expect(tool.resultContract).toBe('explicit-v1');
    const result = await tool.execute!(
      managedTrackRegistrationStartSchema.parse(registration),
      options
    );
    assertToolOperationResult(result);
    expect(result).toMatchObject({
      ok: true,
      input: { path: '/workspace/promoters.gff3', accession: 'NC_000913.3', kinds: ['promoter'] },
    });
    assertMcpOutput(operationsTrackRegistrationStartOutputSchema, result);
    expect(() =>
      assertMcpOutput(operationsTrackRegistrationStartOutputSchema, {
        ...result,
        input: { ...registration, kinds: ['invented-kind'] },
      })
    ).toThrow('MCP output contract rejected factory data');
  });

  it('refuses a track source escaping its workspace before any admission', async () => {
    stat
      .mockResolvedValueOnce({ canonicalPath: '/private/promoters.gff3', isFile: true })
      .mockResolvedValueOnce({ canonicalPath: '/workspace', isDirectory: true });
    const result = await createPrepareManagedTrackRegistrationTool(folders).execute!(
      managedTrackRegistrationStartSchema.parse(registration),
      options
    );
    assertToolOperationResult(result);
    expect(result).toMatchObject({
      ok: false,
      code: 'TRACK_SOURCE_OUTSIDE_WORKSPACE',
      stateChanged: false,
    });
  });

  it('matches actual Python native inspection serialization, including source candidate coordinates', () => {
                                                                                 
                                                                                
                                                                       
    assertMcpOutput(operationsAnnotationInspectOutputSchema, nativeOutput.inspect);
    expect(() =>
      assertMcpOutput(operationsAnnotationInspectOutputSchema, {
        ...nativeOutput.inspect,
        result: { ...nativeOutput.inspect.result, transitionCount: 'one' },
      })
    ).toThrow('MCP output contract rejected factory data');
  });

  it.each(nativeOutput.apply)(
    'matches native saved outcomes with checkpoint $result.checkpoint.status',
    (result) => {
      assertMcpOutput(operationsAnnotationApplyOutputSchema, result);
      expect(() =>
        assertMcpOutput(operationsAnnotationApplyOutputSchema, {
          ...result,
          result: { ...result.result, display: 'invented' },
        })
      ).toThrow('MCP output contract rejected factory data');
    }
  );

  it('keeps both native-owned renderer factories as explicit refusals', async () => {
    const inspect = createInspectManagedAnnotationOperationTool();
    const apply = createApplyManagedAnnotationOperationTool();
    expect(inspect.resultContract).toBe('explicit-v1');
    expect(apply.resultContract).toBe('explicit-v1');
    const replies = [
      await inspect.execute!(
        { operationId: 'operation-one', targetDocumentId: 'sequence-one' },
        options
      ),
      await apply.execute!(
        {
          operationId: 'operation-one',
          targetDocumentId: 'sequence-one',
          expectedOperationVersion: 2,
          expectedResultSha256: `sha256:${'a'.repeat(64)}`,
          expectedTargetDocumentRevision: `annotation-document-v1:sha256:${'b'.repeat(64)}`,
          selectedCandidateIds: ['operation-one:0'],
        },
        options
      ),
    ];
    for (const result of replies) {
      assertToolOperationResult(result);
      expect(result).toMatchObject({
        ok: false,
        code: 'NATIVE_DOCUMENT_OWNER_REQUIRED',
        stateChanged: false,
      });
    }
    expect(() =>
      assertMcpOutput(operationsAnnotationApplyOutputSchema, { ok: true, status: 'saved' })
    ).toThrow('MCP output contract rejected factory data');
  });
});
