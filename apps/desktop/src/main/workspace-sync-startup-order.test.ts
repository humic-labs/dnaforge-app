import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

describe('workspace sync startup authority ordering', () => {
  it('checks schema policy before schema repair and workspace recovery', () => {
    const mainSource = readFileSync(resolve(__dirname, 'index.ts'), 'utf8');
    const policy = mainSource.indexOf('assertSchemaBuildCompatible(database,');
    const schema = mainSource.indexOf('ensureSchemaForBuild(database,');
    expect(policy).toBeGreaterThan(-1);
    expect(schema).toBeGreaterThan(policy);
    expect(
      mainSource.indexOf('await workspaceSync.recoverReplicaPullsBeforeRenderer()')
    ).toBeGreaterThan(schema);
    expect(
      mainSource.indexOf('await purgeExpiredTrashedWorkspaces(getDb(), managedRootDir())')
    ).toBeGreaterThan(schema);
  });
  it('finishes replica recovery before awaiting expired-trash purge', () => {
    const mainSource = readFileSync(resolve(__dirname, 'index.ts'), 'utf8');
    const recovery = mainSource.indexOf('await workspaceSync.recoverReplicaPullsBeforeRenderer()');
    const purge = mainSource.indexOf(
      'await purgeExpiredTrashedWorkspaces(getDb(), managedRootDir())'
    );

    expect(recovery).toBeGreaterThan(-1);
    expect(purge).toBeGreaterThan(recovery);
    expect(mainSource).not.toContain('void purgeExpiredTrashedWorkspaces(');
  });
});
