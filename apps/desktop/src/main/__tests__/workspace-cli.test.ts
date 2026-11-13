import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { resolve } from 'path';

const mainIndex = readFileSync(resolve(__dirname, '../index.ts'), 'utf8');

describe('workspace CLI bootstrap', () => {
  it('queues --workspace until the renderer listener reports ready', () => {
    expect(mainIndex).toContain('function sendWorkspacePathToRenderer');
    expect(mainIndex).toContain("process.argv.find((a) => a.startsWith('--workspace='))");
    expect(mainIndex).toContain('sendWorkspacePathToRenderer(mainWindow, workspacePath)');
    expect(mainIndex).toContain('new WorkspaceSetPathDeliveryCoordinator(');
    expect(mainIndex).toContain(
      'workspaceSetPathDelivery.queue(mainWindow.webContents, workspacePath)'
    );
    expect(mainIndex).toContain("mainIpc.on('workspace:set-path-listener-ready'");
    expect(mainIndex).toContain('workspaceSetPathDelivery.markReady(event.sender)');
  });
});
