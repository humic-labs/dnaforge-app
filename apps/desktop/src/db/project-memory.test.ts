import { beforeEach, describe, expect, it } from 'vitest';
import { clearMockData, getMockFileContent } from '../test/platform-mocks';
import { initializeTestSchema } from '../test/initializeTestSchema';
import {
  appendProjectMemoryEvent,
  createArtifactCreatedProjectMemoryEvent,
  readProjectMemory,
  replayProjectMemoryEvents,
  workspaceRelativeProjectMemoryPath,
  type ProjectMemoryEvent,
} from './project-memory';

describe('project memory', () => {
  beforeEach(async () => {
    clearMockData();
    await initializeTestSchema();
  });

  it('appends artifact-created events and materializes readable project state', async () => {
    const workspaceRoot = '/pm-basic';
    const event = createArtifactCreatedProjectMemoryEvent({
      workspaceRoot,
      entityId: 'design-basic',
      entityKind: 'design',
      displayName: 'Experiment Design',
      filePath: '/pm-basic/designs/Experiment Design.wpdesign.json',
      fileKind: 'design',
      sizeBytes: 128,
      artifactSchema: 'waypoint.design.v1',
      operationId: 'op-basic',
    });

    const snapshot = await appendProjectMemoryEvent({ workspaceRoot, event });

    expect(snapshot).toMatchObject({
      events: [expect.objectContaining({ eventType: 'artifact_created' })],
      entities: [
        expect.objectContaining({
          id: 'design-basic',
          kind: 'design',
          displayName: 'Experiment Design',
          status: 'active',
        }),
      ],
      files: [
        expect.objectContaining({
          entityId: 'design-basic',
          path: 'designs/Experiment Design.wpdesign.json',
          fileKind: 'design',
          status: 'current',
          sizeBytes: 128,
        }),
      ],
    });

    expect(getMockFileContent('/pm-basic/.waypoint/project-memory/manifest.json')).toContain(
      'waypoint.project-memory.manifest.v1'
    );
    expect(getMockFileContent('/pm-basic/.waypoint/project-memory/events.jsonl')).toContain(
      '"artifact_created"'
    );
    expect(getMockFileContent('/pm-basic/.waypoint/project-memory/entities.jsonl')).toContain(
      '"design-basic"'
    );

    await expect(readProjectMemory(workspaceRoot)).resolves.toMatchObject({
      entities: [expect.objectContaining({ id: 'design-basic' })],
      files: [expect.objectContaining({ path: 'designs/Experiment Design.wpdesign.json' })],
    });
  });

  it('rejects paths that cannot be represented as workspace-relative project memory paths', () => {
    expect(() =>
      workspaceRelativeProjectMemoryPath({
        workspaceRoot: '/pm-paths',
        path: '/outside/file.wpdesign.json',
      })
    ).toThrow(/workspace-relative/);

    expect(() =>
      workspaceRelativeProjectMemoryPath({
        workspaceRoot: '/pm-paths',
        path: '/pm-paths/../escape.wpdesign.json',
      })
    ).toThrow(/parent/);
  });

  it('records a native Windows notebook path as a workspace-relative POSIX path', () => {
    const workspaceRoot = 'C:\\Users\\Runner\\Project\\';
    const event = createArtifactCreatedProjectMemoryEvent({
      workspaceRoot,
      entityId: 'windows-notebook',
      entityKind: 'notebook',
      displayName: 'Notebook',
      filePath: 'c:\\users\\runner\\project\\Notes\\Notebook',
      fileKind: 'notebook',
      artifactSchema: 'waypoint.notebook.v1',
    });
    expect(event.paths).toEqual([{ current: 'Notes/Notebook' }]);
    expect(event.payload.file).toMatchObject({ path: 'Notes/Notebook' });
    expect(event.idempotencyKey).toBe('artifact_created:windows-notebook:Notes/Notebook');
    for (const path of [
      'C:/Users/Runner/ProjectSibling/Notebook',
      'D:/Users/Runner/Project/Notebook',
      'C:\\Users\\Runner\\Project\\..\\Notebook',
      'C:Notebook',
    ]) {
      expect(() => workspaceRelativeProjectMemoryPath({ workspaceRoot, path })).toThrow(
        /workspace-relative|parent/
      );
    }
  });

  it('treats repeated idempotent events as no-ops and rejects divergent retries', async () => {
    const workspaceRoot = '/pm-idempotent';
    const event = createArtifactCreatedProjectMemoryEvent({
      workspaceRoot,
      entityId: 'design-idempotent',
      entityKind: 'design',
      displayName: 'Retryable Design',
      filePath: '/pm-idempotent/Retryable Design.wpdesign.json',
      fileKind: 'design',
      artifactSchema: 'waypoint.design.v1',
      operationId: 'op-idempotent',
    });

    await appendProjectMemoryEvent({ workspaceRoot, event });
    const repeated = await appendProjectMemoryEvent({ workspaceRoot, event });

    expect(repeated?.events).toHaveLength(1);

    const divergent: ProjectMemoryEvent = {
      ...event,
      eventId: 'evt-divergent-retry',
      payload: {
        ...event.payload,
        entity: {
          id: 'design-idempotent',
          kind: 'design',
          displayName: 'Changed Retry',
        },
      },
    };

    await expect(appendProjectMemoryEvent({ workspaceRoot, event: divergent })).rejects.toThrow(
      /idempotency conflict/
    );
  });

  it('surfaces conflicting current file bindings for the same entity', () => {
    const workspaceRoot = '/pm-conflict';
    const first = createArtifactCreatedProjectMemoryEvent({
      workspaceRoot,
      entityId: 'design-conflict',
      entityKind: 'design',
      displayName: 'Conflict Design',
      filePath: '/pm-conflict/first.wpdesign.json',
      fileKind: 'design',
      artifactSchema: 'waypoint.design.v1',
      operationId: 'op-conflict-1',
    });
    const second = createArtifactCreatedProjectMemoryEvent({
      workspaceRoot,
      entityId: 'design-conflict',
      entityKind: 'design',
      displayName: 'Conflict Design',
      filePath: '/pm-conflict/second.wpdesign.json',
      fileKind: 'design',
      artifactSchema: 'waypoint.design.v1',
      operationId: 'op-conflict-2',
    });

    const replay = replayProjectMemoryEvents([first, second]);

    expect(replay.conflicts).toEqual(['Entity design-conflict has multiple current file bindings']);
    expect(replay.entities).toEqual([
      expect.objectContaining({ id: 'design-conflict', status: 'conflict' }),
    ]);
    expect(replay.files).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ path: 'first.wpdesign.json', status: 'conflict' }),
        expect.objectContaining({ path: 'second.wpdesign.json', status: 'conflict' }),
      ])
    );
  });

  it('replays artifact renames as historical and current file bindings', () => {
    const workspaceRoot = '/pm-rename';
    const created = createArtifactCreatedProjectMemoryEvent({
      workspaceRoot,
      entityId: 'design-rename',
      entityKind: 'design',
      displayName: 'Old Design',
      filePath: '/pm-rename/Old Design.wpdesign.json',
      fileKind: 'design',
      artifactSchema: 'waypoint.design.v1',
      operationId: 'op-rename-create',
    });
    const renamed: ProjectMemoryEvent = {
      schema: 'waypoint.project-memory.event.v1',
      eventId: 'evt-rename',
      operationId: 'op-rename',
      idempotencyKey:
        'artifact_renamed:design-rename:Old Design.wpdesign.json:Renamed Design.wpdesign.json',
      eventType: 'artifact_renamed',
      actor: { kind: 'user' },
      createdAt: '2026-05-11T00:00:00.000Z',
      entityIds: ['design-rename'],
      paths: [
        {
          before: 'Old Design.wpdesign.json',
          after: 'Renamed Design.wpdesign.json',
        },
      ],
      payload: {},
    };

    const replay = replayProjectMemoryEvents([created, renamed]);

    expect(replay.files).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ path: 'Old Design.wpdesign.json', status: 'historical' }),
        expect.objectContaining({ path: 'Renamed Design.wpdesign.json', status: 'current' }),
      ])
    );
  });
});
