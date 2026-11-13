import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { mergeRendererToolCatalogs } from './catalog/types';
import { ALLOWED_RENDERER_TOOLS } from './renderer-tools';
import { resultTool, toolSuccess, type ToolOperationResult } from './tool-result';

describe('canonical tool result contract', () => {
  it('rejects duplicate feature registrations before a tool can be replaced', () => {
    const catalog = { read_file: ALLOWED_RENDERER_TOOLS.read_file };
    expect(() => mergeRendererToolCatalogs(catalog, catalog)).toThrow(
      'Duplicate renderer tool: read_file'
    );
  });
  it('requires output schemas for new tools and prevents migrated tools regressing', () => {
    const untyped = Object.entries(ALLOWED_RENDERER_TOOLS)
      .filter(([, definition]) => !('outputSchema' in definition) || !definition.outputSchema)
      .map(([name]) => name)
      .sort();
    expect(untyped).toEqual([]);
  });
  it('requires explicit results for new catalog entries and prevents migrated tools regressing', () => {
    const legacy = Object.entries(ALLOWED_RENDERER_TOOLS)
      .filter(([, definition]) => definition.execution.resultContract !== 'explicit-v1')
      .map(([name]) => name)
      .sort();
    expect(legacy).toEqual([]);
  });

  it('fails closed when an untyped factory returns a feature-only refusal', async () => {
    const definition = resultTool({
      inputSchema: z.object({}),
      execute: async () => ({ imported: false, error: 'Exists' }) as unknown as ToolOperationResult,
    });
    await expect(
      definition.execute!({}, { toolCallId: 'invalid', messages: [] })
    ).rejects.toMatchObject({
      code: 'INVALID_TOOL_RESULT',
      retriable: false,
      details: { stateChanged: 'unknown', stateMayHaveChanged: true },
    });
  });

  it('keeps successful empty data intact', async () => {
    const definition = resultTool({
      inputSchema: z.object({}),
      execute: async () => toolSuccess({ entries: [], count: 0 }),
    });
    await expect(definition.execute!({}, { toolCallId: 'empty', messages: [] })).resolves.toEqual({
      ok: true,
      entries: [],
      count: 0,
    });
  });
});
