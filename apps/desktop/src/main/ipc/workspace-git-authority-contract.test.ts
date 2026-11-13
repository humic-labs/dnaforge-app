import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

describe('managed catalog HEAD IPC authority contract', () => {
  const source = readFileSync(resolve(__dirname, 'workspace-git.ts'), 'utf8');
  const group = source.slice(source.indexOf('handleGroup(workspaceContract, {'));
  const start = group.indexOf('\n    indexManagedCatalogHead: ');
  const end = group.indexOf('\n    discoverArtifacts: ', start);
  const handler = group.slice(start, end);

  it('uses the canonical safe path for Git collection and workspace authority', () => {
    expect(start).toBeGreaterThan(0);
    expect(end).toBeGreaterThan(start);
    expect(handler).toContain('return withSafeWritablePath(');
    expect(handler).toContain('request.repoPath,');
    expect(handler).toContain('(repoPath) =>');
    expect(handler).toContain('{ requireAbsolute: true }');
    expect(handler).toContain('collectManagedCatalogHeadIndex(repoPath');
    expect(handler).toContain('workspaceRoot: repoPath');
    expect(handler).toContain('mutationPaths: [repoPath]');
  });

  it('never bypasses renderer authority when healing is disabled', () => {
    expect(handler).toContain('validateManagedCatalogHeadIndexRequest(request)');
    expect(handler).toContain('return withDeclaredRendererWorkspaceMutation({');
    expect(handler).toContain('mutationToken: request.mutationToken');
    expect(handler).not.toMatch(/healWorkingTree\s*===\s*false\s*\?\s*collect/);
  });
});
