import { expect, it, vi } from 'vitest';
const fs = vi.hoisted(() => ({
  appendProjectMemoryEvent: vi.fn(),
  mkdir: vi.fn(),
  writeTextFile: vi.fn(),
}));
vi.mock('../platform', () => ({ platform: () => ({ fs }) }));
import {
  appendProjectMemoryEvent,
  createArtifactCreatedProjectMemoryEvent,
} from './project-memory';
it('submits a whole journal mutation to the native owner without renderer file writes', async () => {
  const event = createArtifactCreatedProjectMemoryEvent({
    workspaceRoot: '/project',
    entityId: 'structure-a',
    entityKind: 'structure',
    displayName: 'Structure A',
    filePath: '/project/Structures/a.pdb',
    fileKind: 'structure',
    artifactSchema: 'structure-coordinates.pdb.v1',
  });
  const snapshot = { events: [event] };
  fs.appendProjectMemoryEvent.mockResolvedValue(snapshot);
  await expect(
    appendProjectMemoryEvent({ workspaceRoot: '/project', event, mutationToken: 'existing-scope' })
  ).resolves.toBe(snapshot);
  expect(fs.appendProjectMemoryEvent).toHaveBeenCalledWith({
    workspaceRoot: '/project',
    event,
    mutationToken: 'existing-scope',
  });
  expect(fs.mkdir).not.toHaveBeenCalled();
  expect(fs.writeTextFile).not.toHaveBeenCalled();
});
