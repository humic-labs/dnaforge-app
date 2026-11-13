import { expect, it, vi } from 'vitest';
import { createQuitPromptBinding, type QuitPromptControls } from './quit-prompt-binding';

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
async function settle() {
  for (let index = 0; index < 6; index += 1) await Promise.resolve();
}

it('retires a pending close decision when a quit request owns the window', async () => {
  const decision = deferred<'proceed' | 'cancel'>();
  const quit = deferred<{ cancelled: boolean }>();
  const destroy = vi.fn();
  const queued: Array<() => void> = [];
  const window = { isDestroyed: () => false, destroy };
  const binding = createQuitPromptBinding({
    isSuppressed: () => false,
    isCutoverBuild: () => false,
    getDirty: () => ({ hasDirtyWork: true, details: 'draft' }),
    isUpdateStaged: () => false,
    hasConsent: () => false,
    grantConsent: vi.fn(),
    showDialog: () => decision.promise,
    getWindow: () => window,
    runQuit: () => quit.promise,
    schedule: (run) => queued.push(run),
  });
  binding.onWindowClose({ preventDefault: vi.fn() }, window);
  queued.shift()!();
  binding.onBeforeQuit({ preventDefault: vi.fn() });
  queued.shift()!();
  decision.resolve('proceed');
  await settle();
  expect(destroy).not.toHaveBeenCalled();
  expect(binding.isQuitting()).toBe(true);
  quit.resolve({ cancelled: true });
  await settle();
  expect(binding.isQuitting()).toBe(false);
  binding.onWindowClose({ preventDefault: vi.fn() }, window);
  expect(queued).toHaveLength(1);
});

it('retains authorization when a scheduler invokes the quit operation immediately', async () => {
  const window = { isDestroyed: () => false, hide: vi.fn() };
  const runQuit = vi.fn(async (controls: QuitPromptControls) => {
    controls.concealRenderer();
    return { cancelled: false };
  });
  const binding = createQuitPromptBinding({
    isSuppressed: () => false,
    isCutoverBuild: () => false,
    getDirty: () => ({ hasDirtyWork: false, details: '' }),
    isUpdateStaged: () => false,
    hasConsent: () => true,
    grantConsent: vi.fn(),
    showDialog: async () => 'proceed',
    getWindow: () => window,
    runQuit,
    schedule: (run) => run(),
  });
  binding.onBeforeQuit({ preventDefault: vi.fn() });
  await settle();
  const preventDefault = vi.fn();
  binding.onBeforeQuit({ preventDefault });
  binding.onWindowClose({ preventDefault }, window);
  expect(preventDefault).not.toHaveBeenCalled();
  expect(runQuit).toHaveBeenCalledTimes(1);
  expect(binding.isQuitting()).toBe(true);
});

it('permits a new quit attempt after the pending attempt is canceled', async () => {
  const queued: Array<() => void> = [];
  const runQuit = vi.fn(async () => ({ cancelled: true }));
  const binding = createQuitPromptBinding({
    isSuppressed: () => false,
    isCutoverBuild: () => false,
    getDirty: () => ({ hasDirtyWork: true, details: 'draft' }),
    isUpdateStaged: () => false,
    hasConsent: () => false,
    grantConsent: vi.fn(),
    showDialog: async () => 'cancel',
    getWindow: () => null,
    runQuit,
    schedule: (run) => queued.push(run),
  });
  for (let attempt = 0; attempt < 2; attempt += 1) {
    binding.onBeforeQuit({ preventDefault: vi.fn() });
    binding.onBeforeQuit({ preventDefault: vi.fn() });
    expect(queued).toHaveLength(1);
    queued.shift()!();
    await settle();
    expect(binding.isQuitting()).toBe(false);
  }
  expect(runQuit).toHaveBeenCalledTimes(2);
});
