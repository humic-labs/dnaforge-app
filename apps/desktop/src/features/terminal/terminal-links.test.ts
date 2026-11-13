import { Terminal, type ILink } from '@xterm/xterm';
import { expect, it, vi } from 'vitest';
import { createTerminalFileLinkProvider } from './terminal-links';

const { stat, openDocument } = vi.hoisted(() => ({ stat: vi.fn(), openDocument: vi.fn() }));
vi.mock('../../platform', () => ({ platform: () => ({ fs: { stat } }) }));
vi.mock('../document-opening/open-document', () => ({ openDocument }));
vi.mock('../canvas/public/store', () => ({ useCanvasStore: {} }));
vi.mock('../../commands', () => ({ COMMAND_IDS: { workspaceRevealPath: 'workspace.revealPath' } }));

it('marks native folder activation as an explicit outside-folder opening intent', async () => {
  const terminal = new Terminal({ cols: 80, rows: 8, allowProposedApi: true });
  const dispatch = vi.fn();
  try {
    await new Promise<void>((resolve) => terminal.write('/outside/directory', resolve));
    stat.mockResolvedValue({ isFile: false, isDirectory: true });
    const provider = createTerminalFileLinkProvider(
      terminal,
      () => '/workspace',
      dispatch,
      vi.fn()
    );
    const links = await new Promise<ILink[] | undefined>((resolve) =>
      provider.provideLinks(1, resolve)
    );
    links![0]!.activate(new MouseEvent('click', { metaKey: true }), '/outside/directory');
    expect(dispatch).toHaveBeenCalledWith('workspace.revealPath', {
      source: 'ui',
      payload: { path: '/outside/directory', openOutsideFolder: true },
    });
  } finally {
    terminal.dispose();
  }
});

it('skips native file verification when disabled, including a pending result', async () => {
  const terminal = new Terminal({ cols: 80, rows: 8, allowProposedApi: true });
  try {
    await new Promise<void>((resolve) => terminal.write('/workspace/notes.txt:2:3', resolve));
    let enabled = false;
    const provider = createTerminalFileLinkProvider(
      terminal,
      () => '/workspace',
      vi.fn(),
      vi.fn(),
      () => undefined,
      () => undefined,
      () => enabled
    );
    const links = () =>
      new Promise<ILink[] | undefined>((resolve) => provider.provideLinks(1, resolve));
    stat.mockClear();
    stat.mockResolvedValue({ isFile: true, isDirectory: false });
    expect(await links()).toEqual([]);
    expect(stat).not.toHaveBeenCalled();

    enabled = true;
    let finish!: (value: { isFile: boolean; isDirectory: boolean }) => void;
    stat.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        })
    );
    const pending = links();
    expect(stat).toHaveBeenCalledWith('/workspace/notes.txt');
    enabled = false;
    finish({ isFile: true, isDirectory: false });
    expect(await pending).toEqual([]);

    enabled = true;
    stat.mockResolvedValue({ isFile: true, isDirectory: false });
    const detected = await links();
    expect(detected).toMatchObject([{ text: '/workspace/notes.txt:2:3' }]);
    enabled = false;
    detected![0].activate(new MouseEvent('click', { metaKey: true }), detected![0].text);
    expect(openDocument).not.toHaveBeenCalled();
  } finally {
    terminal.dispose();
  }
});
