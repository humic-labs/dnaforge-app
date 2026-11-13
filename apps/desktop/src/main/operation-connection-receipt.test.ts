import { mkdtempSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  operationRuntimeDirectory,
  retireOperationConnectionReceipt,
} from './operation-connection-receipt';

const directories: string[] = [];

function registry(): string {
  const directory = mkdtempSync(join(tmpdir(), 'operation-registry-'));
  directories.push(directory);
  return directory;
}

function receipt(directory: string, name: string, sessionToken: string): void {
  writeFileSync(
    join(directory, `${name}.connection.json`),
    JSON.stringify({ version: 1, session_token: sessionToken, pid: 1 })
  );
}

afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true });
});

describe('retireOperationConnectionReceipt', () => {
  it('removes only the receipt published by the exited launch', () => {
    const directory = registry();
    receipt(directory, 'exited', 'launch-1');
    receipt(directory, 'other-app', 'launch-2');
    writeFileSync(join(directory, 'notes.json'), JSON.stringify({ session_token: 'launch-1' }));

    retireOperationConnectionReceipt('launch-1', directory);

    expect(readdirSync(directory).sort()).toEqual(['notes.json', 'other-app.connection.json']);
  });

  it('ignores unreadable entries and a missing registry', () => {
    const directory = registry();
    writeFileSync(join(directory, 'corrupt.connection.json'), '{');
    symlinkSync(join(directory, 'elsewhere'), join(directory, 'link.connection.json'));

    expect(() => retireOperationConnectionReceipt('launch-1', directory)).not.toThrow();
    expect(() =>
      retireOperationConnectionReceipt('launch-1', join(directory, 'absent'))
    ).not.toThrow();
    expect(readdirSync(directory).sort()).toEqual([
      'corrupt.connection.json',
      'link.connection.json',
    ]);
  });

  it('follows the same registry override as the sidecar', () => {
    expect(operationRuntimeDirectory({ DNAFORGE_OPERATION_RUNTIME_DIR: '/tmp/registry' })).toBe(
      '/tmp/registry'
    );
    expect(operationRuntimeDirectory({})).toMatch(/\.dnaforge[\\/]operations$/);
  });
});
