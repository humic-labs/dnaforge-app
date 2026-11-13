import { expect, it } from 'vitest';
import { resolveTerminalLinkPath } from './upstream/terminal-link-path';

it('resolves a literal home path against native home independently of the current folder', () => {
  expect(resolveTerminalLinkPath('~/project/file.txt', '/elsewhere', '/Users/example')).toBe(
    '/Users/example/project/file.txt'
  );
  expect(resolveTerminalLinkPath('~/project/file.txt', '/elsewhere', undefined)).toBeUndefined();
  expect(resolveTerminalLinkPath('file.txt', '/workspace', '/Users/example')).toBe(
    '/workspace/file.txt'
  );
  expect(resolveTerminalLinkPath('/absolute/file.txt', '/elsewhere', '/Users/example')).toBe(
    '/absolute/file.txt'
  );
});
