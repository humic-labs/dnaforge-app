import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

const sourceRoot = resolve(__dirname, '../..');

function source(relativePath: string): string {
  return readFileSync(resolve(sourceRoot, relativePath), 'utf8');
}

describe('workspace sync replica lifecycle IPC surface', () => {
  it('keeps the preload implementation and both public bridge declarations in parity', () => {
    expect(source('preload/index.ts')).toMatch(/onReplicaLifecycle:\s*\(/);
    expect(source('preload/index.d.ts')).toMatch(/onReplicaLifecycle\(\s*callback:/);
    expect(source('platform/types.ts')).toMatch(/onReplicaLifecycle\(\s*callback:/);
    expect(source('platform/electron.ts')).toMatch(
      /onReplicaLifecycle:\s*\(callback\)\s*=>\s*api\(\)\.cloudSync\.onReplicaLifecycle\(callback\)/
    );
  });

  it('keeps the main-to-renderer event and renderer acknowledgement channels wired', () => {
    const main = source('main/features/workspace-sync.ts');
    const preload = source('preload/index.ts');
    const contract = source('shared/ipc-contract.ts');

    expect(main).toContain("sendRendererIpc(window.webContents, 'cloudSync:replicaApplied'");
    expect(main).toContain("mainIpc.on('cloudSync:replicaAppliedAck'");
    expect(preload).toContain("rendererIpc.on('cloudSync:replicaApplied'");
    expect(preload).toContain("rendererIpc.send('cloudSync:replicaAppliedAck'");
    expect(contract).toContain("'cloudSync:replicaApplied': EventEntry");
    expect(contract).toContain("'cloudSync:replicaAppliedAck': EventEntry");
  });
});
