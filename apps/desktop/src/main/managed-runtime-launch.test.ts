// @vitest-environment node
import { expect, it } from 'vitest';
import { resolve } from 'node:path';
import { parseManagedRuntimeLaunch } from './managed-runtime-launch';

it('leaves ordinary application and file launches alone', () => {
  expect(parseManagedRuntimeLaunch(['app', '--workspace=/work'], '/tmp')).toBeNull();
});

it('accepts explicit foreground operation ownership with optional enrolled roots', () => {
  expect(parseManagedRuntimeLaunch(['app', '--managed-runtime'], '/tmp')).toEqual({
    workspaceRoots: [],
  });
  expect(
    parseManagedRuntimeLaunch(
      [
        'app',
        '--managed-runtime',
        '--workspace=project',
        '--workspace',
        'project with spaces',
        '--workspace=project',
      ],
      '/tmp'
    )
  ).toEqual({
    workspaceRoots: [resolve('/tmp', 'project'), resolve('/tmp', 'project with spaces')],
  });
});

it.each([
  ['--managed-runtime=false'],
  ['--managed-runtime', '--workspace'],
  ['--managed-runtime', '--workspace='],
  ['--managed-runtime', '--workspace', '--e2e'],
])('refuses a malformed managed launch %j', (...args) => {
  expect(() => parseManagedRuntimeLaunch(args, '/tmp')).toThrow();
});
