import { describe, expect, it, vi } from 'vitest';
import type { WorkspaceFolder } from '../../stores/workspaceStore';
import {
  callRendererTool,
  type RendererAuditRecord,
  type RendererAuditSink,
} from './renderer-bridge';
import { getAllowedRendererTool } from './renderer-tools';

const FOLDERS: WorkspaceFolder[] = [{ path: '/workspace', name: 'Workspace', addedAt: 1 }];
const OUTPUT_SHA = `sha256:${'a'.repeat(64)}`;
const TARGET_REVISION = `annotation-document-v1:sha256:${'b'.repeat(64)}`;

function auditSink(): { sink: RendererAuditSink; records: RendererAuditRecord[] } {
  const records: RendererAuditRecord[] = [];
  return {
    sink: {
      write: vi.fn(async (record) => {
        records.push(record);
        return `audit-${records.length}`;
      }),
    },
    records,
  };
}

function request(toolName: string, args: Record<string, unknown>) {
  return {
    tool_name: toolName,
    args,
    agent_identity: 'agent-annotation-output',
    action_id: `action-${toolName}`,
  };
}

const inspectArgs = {
  outputPath: 'runs/result.json',
  format: 'json',
  targetDocumentId: 'sequence-1',
};

const applyArgs = {
  ...inspectArgs,
  expectedOutputSha256: OUTPUT_SHA,
  expectedTargetDocumentRevision: TARGET_REVISION,
  selectedCandidateIds: [`annotation-output:${'a'.repeat(64)}:0`],
};

describe('annotation output renderer authority', () => {
  it.each([
    ['inspect_annotation_output', inspectArgs, ['read-workspace']],
    ['apply_annotation_output', applyArgs, ['read-workspace', 'read-sequences']],
  ])(
    'rejects %s before its handler when a required capability is missing',
    async (toolName, args, capabilities) => {
      const tool = getAllowedRendererTool(toolName);
      expect(tool).not.toBeNull();
      if (!tool) throw new Error(`Missing renderer tool: ${toolName}`);
      expect(tool.execution.kind).toBe('sdk');
      if (tool.execution.kind !== 'sdk') {
        throw new Error(`Expected SDK renderer tool: ${toolName}`);
      }
      const createTool = vi.spyOn(tool.execution, 'createTool');
      const audit = auditSink();
      try {
        const response = await callRendererTool(request(toolName, args), {
          folders: FOLDERS,
          agentCapabilities: capabilities,
          auditSink: audit.sink,
        });

        expect(response).toMatchObject({
          ok: false,
          error: { code: 'INSUFFICIENT_SCOPE' },
        });
        expect(createTool).not.toHaveBeenCalled();
        expect(audit.records).toHaveLength(1);
        expect(audit.records[0]).toMatchObject({
          tool_name: toolName,
          status: 'rejected',
          actor_scope: capabilities,
        });
      } finally {
        createTool.mockRestore();
      }
    }
  );

  it.each([
    ['inspect_annotation_output', inspectArgs, ['read-workspace', 'read-sequences']],
    ['apply_annotation_output', applyArgs, ['read-workspace', 'read-sequences', 'write-workspace']],
  ])(
    'rejects %s before its handler when no explicit workspace root is mounted',
    async (toolName, args, capabilities) => {
      const tool = getAllowedRendererTool(toolName);
      expect(tool).not.toBeNull();
      if (!tool) throw new Error(`Missing renderer tool: ${toolName}`);
      expect(tool.execution.kind).toBe('sdk');
      if (tool.execution.kind !== 'sdk') {
        throw new Error(`Expected SDK renderer tool: ${toolName}`);
      }
      const createTool = vi.spyOn(tool.execution, 'createTool');
      const audit = auditSink();
      try {
        const response = await callRendererTool(request(toolName, args), {
          folders: [],
          agentCapabilities: capabilities,
          auditSink: audit.sink,
        });

        expect(response).toMatchObject({ ok: false, error: { code: 'NO_WORKSPACE' } });
        expect(createTool).not.toHaveBeenCalled();
      } finally {
        createTool.mockRestore();
      }
    }
  );
});
