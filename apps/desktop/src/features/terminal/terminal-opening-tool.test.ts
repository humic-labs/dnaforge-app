import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import {
  createOpenTerminalTool,
  openTerminalSchema,
  openTerminalOutputSchema,
} from '../ai/public/tools/open-terminal';
import { registerTerminalViewOpener, TerminalOpeningError } from './terminal-opening';

const state = vi.hoisted(() => ({ native: true }));
vi.mock('../../platform', () => ({
  platform: () => ({ terminal: state.native ? {} : undefined }),
}));
let unregister: (() => void) | undefined;
beforeEach(() => {
  state.native = true;
});
afterEach(() => {
  unregister?.();
  unregister = undefined;
});
const execute = (input: unknown = {}) =>
  createOpenTerminalTool().execute!(openTerminalSchema.parse(input), {
    toolCallId: 'terminal-test',
    messages: [],
  });

it('defaults to a new app tab and refuses command/executable/environment inputs', () => {
  expect(openTerminalSchema.parse({})).toEqual({ mode: 'tab' });
  for (const input of [{ command: 'echo unwanted' }, { executable: '/bin/sh' }, { env: {} }])
    expect(openTerminalSchema.safeParse(input).success).toBe(false);
});
it('fails before touching the controller when native terminals are unavailable', async () => {
  state.native = false;
  const handler = vi.fn();
  unregister = registerTerminalViewOpener(handler);
  expect(await execute()).toMatchObject({
    ok: false,
    code: 'TERMINAL_UNAVAILABLE',
    stateChanged: false,
  });
  expect(handler).not.toHaveBeenCalled();
});
it('reports an unmounted controller without claiming a tab was opened', async () => {
  expect(await execute()).toMatchObject({
    ok: false,
    code: 'TERMINAL_UNAVAILABLE',
    stateChanged: false,
  });
});
it('returns the actual controller identities after its asynchronous open finishes', async () => {
  const result = {
    sessionId: crypto.randomUUID(),
    groupId: 'group',
    viewId: 'view',
    tabId: 'tab',
    title: 'tmp',
    cwd: '/tmp',
  };
  const handler = vi.fn(async () => result);
  unregister = registerTerminalViewOpener(handler);
  const opened = await execute({ mode: 'split', parentSessionId: result.sessionId });
  expect(openTerminalOutputSchema.parse(opened)).toEqual({
    ...result,
    ok: true,
  });
  expect(handler).toHaveBeenCalledWith({ mode: 'split', parentSessionId: result.sessionId });
});
it('retains a created shell identity when presentation fails, without declaring success', async () => {
  unregister = registerTerminalViewOpener(async () => {
    throw new TerminalOpeningError('TERMINAL_VIEW_FAILED', 'The view did not open.', {
      stateChanged: true,
      sessionId: 'created-shell',
    });
  });
  expect(await execute()).toMatchObject({
    ok: false,
    code: 'TERMINAL_VIEW_FAILED',
    stateChanged: true,
    partialEffects: [{ sessionId: 'created-shell' }],
  });
});
