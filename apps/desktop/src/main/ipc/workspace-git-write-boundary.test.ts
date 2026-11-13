import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const source = readFileSync(resolve(process.cwd(), 'src/main/ipc/workspace-git.ts'), 'utf8');
const filesystemSource = readFileSync(resolve(process.cwd(), 'src/main/ipc/filesystem.ts'), 'utf8');
const relocateSource = readFileSync(
  resolve(process.cwd(), 'src/main/workspace-file-relocation.ts'),
  'utf8'
);
const hostedBrokerSource = readFileSync(
  resolve(process.cwd(), 'src/main/hosted-native-tool-broker.ts'),
  'utf8'
);
const hostedGatewaySource = readFileSync(
  resolve(process.cwd(), 'src/main/ipc/hosted-ai-gateway.ts'),
  'utf8'
);

function handlerSource(channel: string): string {
  const method = channel.slice(channel.indexOf(':') + 1);
  const group = source.slice(source.indexOf('handleGroup(workspaceContract, {'));
  const entry = group.search(new RegExp(`\\n    ${method}: `));
  if (entry > 0) {
    const next = group.slice(entry + 1).search(/\n    [A-Za-z0-9]+: /);
    return group.slice(entry, next < 0 ? group.indexOf('\n  });') : entry + 1 + next);
  }
  const start = source.indexOf(`'${channel}'`);
  if (start < 0) throw new Error(`Missing IPC handler: ${channel}`);
  const next = source.indexOf('mainIpc.handle', start);
  return source.slice(start, next < 0 ? source.length : next);
}

describe('workspace mutation IPC boundary', () => {
  it.each([
    ['workspace:importFile', 'request.targetRoot'],
    ['workspace:importFileFromContent', 'request.targetRoot'],
    ['workspace:importSequenceFromContent', 'request.targetRoot'],
    ['workspace:importFolder', 'request.targetRoot'],
    ['workspace:registerImportedSequence', 'request.targetRoot'],
    ['workspace:registerImportedSequenceFromContent', 'request.targetRoot'],
    ['workspace:indexManagedHead', 'request.repoPath'],
    ['workspace:indexManagedCatalogHead', 'request.repoPath'],
  ])('%s holds a writable-path lease through its full operation', (channel, expression) => {
    expect(handlerSource(channel).replace(/\s+/gu, '')).toContain(
      `withSafeWritablePath(${expression}`
    );
  });

  it('leases the exact trashed workspace container through permanent deletion', () => {
    expect(handlerSource('workspace:purgeTrashed')).toContain(
      'withSafeWritablePath(dirname(row.path)'
    );
  });

  it('protects in-place sequence packaging with canonical writable paths', () => {
    const start = filesystemSource.indexOf("'fs:packageSequenceFile'");
    const end = filesystemSource.indexOf('fs:createPackageScratch', start);
    const handler = filesystemSource.slice(start, end);

    expect(handler).toContain('withSafeWritablePath(sourceWorkspaceRoot');
    expect(handler).toContain('materializeImportedSequencePackages(safeFilePath');
  });

  it('holds one atomic lease over both sides of relocate and relink operations', () => {
    expect(relocateSource.match(/return withSafeWritablePaths\(requests/g)).toHaveLength(2);
    expect(relocateSource).not.toContain('assertSafeWritablePath');
  });

  it('leases every package scratch mutation for its complete capability operation', () => {
    for (const channel of [
      'fs:createPackageScratch',
      'fs:removePackageScratch',
      'fs:renamePackageScratchMember',
    ]) {
      const start = filesystemSource.indexOf(`'${channel}'`);
      const end = filesystemSource.indexOf('mainIpc.handle', start);
      expect(filesystemSource.slice(start, end), channel).toMatch(/withSafeWritablePath/);
    }
  });

  it('leases Hosted native mutations during approval preflight and through dispatch completion', () => {
    expect(hostedGatewaySource).toContain('withSafeWritablePaths: (paths, operation) =>');
    expect(hostedGatewaySource).toContain('prepareShellProcess: (request) =>');
    expect(hostedGatewaySource).toContain('prepareHostedNativeShellLaunch({');
    expect(hostedGatewaySource).toContain('resolveBinary: getVerifiedAppServerBinary');
    expect(hostedGatewaySource).toContain(
      'withHostedNativeWritablePaths(getDb(), paths, operation)'
    );
    expect(hostedBrokerSource).toContain('this.deps.withSafeWritablePaths(requestedPaths');
    const preflight = hostedBrokerSource.slice(
      hostedBrokerSource.indexOf('private async preflightMutation('),
      hostedBrokerSource.indexOf('async execute(')
    );
    const execution = hostedBrokerSource.slice(
      hostedBrokerSource.indexOf('private async write('),
      hostedBrokerSource.indexOf('private async withRevalidatedWritablePaths')
    );
    expect(preflight.match(/this\.withRevalidatedWritablePaths\(/g)?.length).toBe(6);
    expect(execution.match(/this\.withRevalidatedWritablePaths\(/g)?.length).toBe(6);
  });
});
