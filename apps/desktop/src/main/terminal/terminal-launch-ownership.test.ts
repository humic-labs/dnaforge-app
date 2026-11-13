import { afterEach, describe, expect, it, vi } from 'vitest';
import { TerminalService } from './terminal-service';
import { prepareTerminalShell } from './shell-launch';

vi.mock('node-pty', () => ({ spawn: vi.fn() }));
vi.mock('./shell-launch', () => ({
  prepareTerminalShell: vi.fn(),
  detectTerminalProfiles: () => [],
}));

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
function launch() {
  return {
    args: [],
    env: {},
    originalEnvironment: {},
    nonce: 'test-nonce',
    cleanup: vi.fn(async () => {}),
  };
}
function fixture() {
  const spawn = vi.fn(() => {
    let exit = () => {};
    return {
      pid: 123,
      write: vi.fn(),
      resize: vi.fn(),
      pause: vi.fn(),
      resume: vi.fn(),
      kill: () => queueMicrotask(exit),
      onData: () => ({ dispose: vi.fn() }),
      onExit: (listener: (value: { exitCode: number }) => void) => {
        exit = () => listener({ exitCode: 0 });
        return { dispose: vi.fn() };
      },
    };
  });
  const service = new TerminalService({
    spawn,
    profiles: [{ id: 'test', name: 'test', path: '/bin/sh', args: [] }],
    integrationRoot: null,
    emit: vi.fn(),
  });
  return { service, spawn };
}
afterEach(() => vi.resetAllMocks());

describe('terminal launch ownership', () => {
  it('retires a launch when its renderer owner closes during shell preparation', async () => {
    const prepared = deferred<ReturnType<typeof launch>>();
    vi.mocked(prepareTerminalShell).mockReturnValue(prepared.promise);
    const f = fixture();
    const creating = f.service.create(1, { cwd: '/tmp' }).then(
      (value) => ({ value }),
      (error) => ({ error })
    );
    await vi.waitFor(() => expect(prepareTerminalShell).toHaveBeenCalledTimes(1));
    f.service.closeOwner(1);
    const resource = launch();
    prepared.resolve(resource);
    const result = await creating;
    try {
      expect(result).toHaveProperty('error');
      expect(f.spawn).not.toHaveBeenCalled();
      expect(f.service.list(1)).toEqual([]);
      expect(resource.cleanup).toHaveBeenCalledTimes(1);
    } finally {
      await f.service.dispose();
    }
  });

  it('refuses a delayed renderer request admitted after its owner closed', async () => {
    vi.mocked(prepareTerminalShell).mockResolvedValue(launch());
    const f = fixture();
    f.service.closeOwner(1);
    const result = await f.service.create(1, { cwd: '/tmp' }).then(
      (value) => ({ value }),
      (error) => ({ error })
    );
    try {
      expect(result).toHaveProperty('error');
      expect(f.spawn).not.toHaveBeenCalled();
    } finally {
      await f.service.dispose();
    }
  });

  it('does not resurrect a terminal closed while Relaunch prepares a replacement', async () => {
    vi.mocked(prepareTerminalShell).mockResolvedValueOnce(launch());
    const f = fixture();
    const original = await f.service.create(1, { cwd: '/tmp' });
    const prepared = deferred<ReturnType<typeof launch>>();
    vi.mocked(prepareTerminalShell).mockReturnValueOnce(prepared.promise);
    const replacing = f.service.relaunch(1, original.id).then(
      (value) => ({ value }),
      (error) => ({ error })
    );
    await vi.waitFor(() => expect(prepareTerminalShell).toHaveBeenCalledTimes(2));
    f.service.close(1, original.id);
    const resource = launch();
    prepared.resolve(resource);
    const result = await replacing;
    try {
      expect(result).toHaveProperty('error');
      expect(f.spawn).toHaveBeenCalledTimes(1);
      expect(f.service.list(1)).toEqual([]);
      expect(resource.cleanup).toHaveBeenCalledTimes(1);
    } finally {
      await f.service.dispose();
    }
  });

  it('does not steal a terminal moved to another window during Relaunch', async () => {
    vi.mocked(prepareTerminalShell).mockResolvedValueOnce(launch());
    const f = fixture();
    const original = await f.service.create(1, { cwd: '/tmp' });
    const prepared = deferred<ReturnType<typeof launch>>();
    vi.mocked(prepareTerminalShell).mockReturnValueOnce(prepared.promise);
    const replacing = f.service.relaunch(1, original.id).then(
      (value) => ({ value }),
      (error) => ({ error })
    );
    await vi.waitFor(() => expect(prepareTerminalShell).toHaveBeenCalledTimes(2));
    f.service.transferSessions(1, 2, [original.id]);
    const resource = launch();
    prepared.resolve(resource);
    const result = await replacing;
    try {
      expect(result).toHaveProperty('error');
      expect(f.spawn).toHaveBeenCalledTimes(1);
      expect(f.service.list(1)).toEqual([]);
      expect(f.service.list(2).map((s) => s.id)).toEqual([original.id]);
      expect(resource.cleanup).toHaveBeenCalledTimes(1);
    } finally {
      await f.service.dispose();
    }
  });
});
