import { describe, expect, it } from 'vitest';
import { resolveChatWorkspacePath } from './chat-workspace';

describe('resolveChatWorkspacePath', () => {
  it('keeps an explicitly selected mounted project authoritative regardless of mount order', () => {
    expect(
      resolveChatWorkspacePath('/Users/scientist/live-project', [
        {
          path: '/Users/scientist/dev-assets',
          name: 'Dev Assets',
          addedAt: 1,
          pinned: true,
        },
        {
          path: '/Users/scientist/Library/Application Support/@waypoint/desktop-dev-1430/dev-scenarios/agent-trace-cli-session/workspace/agent-trace-cli',
          name: 'agent-trace-cli',
          addedAt: 2,
        },
        {
          path: '/Users/scientist/live-project',
          name: 'Live project',
          addedAt: 3,
        },
      ])
    ).toBe('/Users/scientist/live-project');
  });

  it('refuses a persisted path that is not mounted even when only pinned helpers exist', () => {
    expect(
      resolveChatWorkspacePath('/Users/scientist/live-workspace', [
        {
          path: '/Users/scientist/dev-assets',
          name: 'Dev Assets',
          addedAt: 1,
          pinned: true,
        },
      ])
    ).toBeNull();
  });

  it('refuses an unmounted stale selection when several projects are open', () => {
    expect(
      resolveChatWorkspacePath('/Users/scientist/archived-project', [
        { path: '/Users/scientist/project-a', name: 'A', addedAt: 1 },
        { path: '/Users/scientist/project-b', name: 'B', addedAt: 2 },
      ])
    ).toBeNull();
  });
});
