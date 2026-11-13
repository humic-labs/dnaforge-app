import { beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  AdministrationEvent,
  AdministrationResult,
  AdministrationSettingsSnapshot,
} from '../shared/administration';

const ports = vi.hoisted(() => ({
  execute: vi.fn(),
  listener: null as ((event: AdministrationEvent) => void) | null,
}));
vi.mock('../platform', () => ({
  platform: () => ({
    administration: {
      execute: ports.execute,
      onChanged: (listener: (event: AdministrationEvent) => void) => {
        ports.listener = listener;
        return () => {};
      },
    },
  }),
}));

function state(generation: number, theme: 'light' | 'dark'): AdministrationSettingsSnapshot {
  return {
    ownerId: 'owner-one',
    generation,
    revision: `native-${generation}`,
    values: { theme, displayZoom: 1, assemblyColorScheme: 'tailwind', webglPerformance: 'auto' },
    adopted: ['theme'],
    persistence: 'saved',
    unsavedKeys: [],
  };
}
beforeEach(() => {
  vi.resetModules();
  ports.execute.mockReset();
  ports.listener = null;
});

describe('native administration client', () => {
  it('never lets an older IPC reply replace a newer native owner observation', async () => {
    let release!: (result: AdministrationResult) => void;
    ports.execute.mockImplementation(
      () =>
        new Promise((resolve) => {
          release = resolve;
        })
    );
    const client = await import('./administration-client');
    const observations: string[] = [];
    client.subscribeAdministrationSettings((snapshot) => observations.push(snapshot.values.theme));
    const pending = client.inspectAdministrationSettings();
    ports.listener?.({ kind: 'settings', snapshot: state(2, 'dark') });
    release({ kind: 'settings', snapshot: state(1, 'light'), stateChanged: false });
    expect((await pending).values.theme).toBe('dark');
    expect(observations).toEqual(['dark']);
  });

  it('sends the exact inspected revision for a human change and does not request another approval', async () => {
    ports.execute
      .mockResolvedValueOnce({ kind: 'settings', snapshot: state(1, 'light'), stateChanged: false })
      .mockResolvedValueOnce({ kind: 'settings', snapshot: state(2, 'dark'), stateChanged: true });
    const client = await import('./administration-client');
    expect((await client.changeAdministrationSettings({ theme: 'dark' })).values.theme).toBe(
      'dark'
    );
    expect(ports.execute.mock.calls).toEqual([
      [{ operation: { kind: 'inspect-settings' } }],
      [
        {
          operation: {
            kind: 'update-settings',
            expectedRevision: 'native-1',
            patch: { theme: 'dark' },
          },
        },
      ],
    ]);
  });
});
