import type { WorkTaskQueryResult } from '../../shared/work-tasks-ipc';

export async function emptyWorkTaskQuery(): Promise<WorkTaskQueryResult> {
  return {
    actor: { kind: 'local', id: 'test-device' },
    now: 0,
    projects: [],
    tasks: [],
    total: 0,
    nextOffset: null,
    unavailable: [],
  };
}
