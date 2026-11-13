import { expect, it } from 'vitest';
import { ownedForegroundListener, type PortSnapshot } from './port-owner';

it('accepts only listener descendants in the owned foreground group and preserves generations', () => {
  const snapshot: PortSnapshot = {
    listeners: [12],
    processes: [
      { pid: 10, parent: 1, group: 10, foreground: 12, born: 'shell-a', executable: 'bash' },
      { pid: 12, parent: 10, group: 12, foreground: 12, born: 'program-a', executable: 'node' },
    ],
  };
  expect(ownedForegroundListener(snapshot, 10, 'node', false)).toBe('10:shell-a|12:program-a');
  expect(
    ownedForegroundListener({ ...snapshot, listeners: [99] }, 10, 'node', false)
  ).toBeUndefined();
  expect(
    ownedForegroundListener(
      {
        ...snapshot,
        processes: snapshot.processes.map((p) => (p.pid === 12 ? { ...p, group: 13 } : p)),
      },
      10,
      'node',
      false
    )
  ).toBeUndefined();
  expect(ownedForegroundListener(snapshot, 10, 'node', true)).toBe('10:shell-a|12:program-a');
  expect(ownedForegroundListener(snapshot, 10, 'different', true)).toBeUndefined();
  expect(
    ownedForegroundListener(
      {
        ...snapshot,
        processes: [
          ...snapshot.processes,
          {
            pid: 13,
            parent: 10,
            group: 13,
            foreground: 13,
            born: 'other-node',
            executable: 'node',
          },
        ],
      },
      10,
      'node',
      true
    )
  ).toBeUndefined();
  expect(
    ownedForegroundListener(
      {
        ...snapshot,
        processes: snapshot.processes.map((p) => (p.pid === 12 ? { ...p, born: 'reused-pid' } : p)),
      },
      10,
      'node',
      false
    )
  ).not.toBe(ownedForegroundListener(snapshot, 10, 'node', false));
});
