import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const QUERY_SOURCE = readFileSync(join(__dirname, '..', 'query.ts'), 'utf8');

const ROUTE_ENTRY_POINTS = [
  { name: 'claude', fn: 'export async function queryClaudeCode' },
  { name: 'codex', fn: 'export async function queryCodex' },
  { name: 'grok', fn: 'export async function queryGrok' },
] as const;

function functionBody(source: string, signature: string): string {
  const start = source.indexOf(signature);
  if (start === -1) throw new Error(`Could not find ${signature} in query.ts`);

  const paramOpen = source.indexOf('(', start);
  let parenDepth = 0;
  let paramClose = -1;
  for (let i = paramOpen; i < source.length; i += 1) {
    if (source[i] === '(') parenDepth += 1;
    else if (source[i] === ')') {
      parenDepth -= 1;
      if (parenDepth === 0) {
        paramClose = i;
        break;
      }
    }
  }
  if (paramClose === -1) throw new Error(`Unbalanced parentheses after ${signature}`);

  const open = source.indexOf('{', paramClose);
  let depth = 0;
  for (let i = open; i < source.length; i += 1) {
    if (source[i] === '{') depth += 1;
    else if (source[i] === '}') {
      depth -= 1;
      if (depth === 0) return source.slice(open, i + 1);
    }
  }
  throw new Error(`Unbalanced braces after ${signature}`);
}

describe('agent route parity — tool exposure', () => {
  it.each(ROUTE_ENTRY_POINTS)(
    'the $name route reserves blocking diagnostics for required workflows',
    ({ fn }) => {
      const body = functionBody(QUERY_SOURCE, fn);
      expect(
        body.includes('requiresToolPreflight(options)'),
        'This route does not distinguish ordinary chat from an explicitly required tool workflow.'
      ).toBe(true);
      expect(
        body.includes('proveChatToolsOrFail'),
        'Required tool workflows on this route have no full companion preflight.'
      ).toBe(true);
    }
  );

  it.each(ROUTE_ENTRY_POINTS)(
    'the $name route short-circuits when a required-workflow proof fails',
    ({ fn }) => {
      const body = functionBody(QUERY_SOURCE, fn);

      expect(body).toMatch(
        /const failed = await proveChatToolsOrFail\([^)]*\);\s*if \(failed\) return failed;/
      );
    }
  );

  it.each(ROUTE_ENTRY_POINTS)(
    'the $name route does not require a bridge for every chat',
    ({ fn }) => {
      const body = functionBody(QUERY_SOURCE, fn);
      expect(body).not.toContain('isChat && !options.cliMcpBridge');
    }
  );

  it('the required-tool set is derived from the manifest, never hand-listed here', async () => {
    const { requiredWorkspaceToolNames } = await import('../required-workspace-tools');
    const names = requiredWorkspaceToolNames();
    expect(names.length).toBeGreaterThan(0);
    expect(names).toContain('list_files');

    expect(names.length).toBeGreaterThan(5);
  });

  it('derives grounding reads from the manifest while excluding UI-only writes', async () => {
    const { workspaceGroundingToolNames } = await import('../required-workspace-tools');
    const names = workspaceGroundingToolNames();
    expect(names).toContain('list_files');
    expect(names).toContain('read_file');
    expect(names).toContain('selection_translate');
    expect(names).toContain('backtranslate');
    expect(names).toContain('get_workspace');
    expect(names).toContain('virtual_digest');
    expect(names).toContain('assembly.listEditableFields');
    expect(names).not.toContain('highlight_range');
  });

  it('grounds completed project reads while excluding managed skills and invalid arguments', async () => {
    const { toolCallGroundsWorkspace } = await import('../required-workspace-tools');
    expect(toolCallGroundsWorkspace('read_file', { path: 'constructs/pUC19.gb' })).toBe(true);
    expect(toolCallGroundsWorkspace('read_file', { path: 'skill://all/review/SKILL.md' })).toBe(
      false
    );
    expect(toolCallGroundsWorkspace('read_file', { path: '' })).toBe(false);
    expect(toolCallGroundsWorkspace('read_file', {})).toBe(false);
    expect(toolCallGroundsWorkspace('read_file', null)).toBe(false);
    expect(toolCallGroundsWorkspace('search_skills', {})).toBe(false);
  });
});
