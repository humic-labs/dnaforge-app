import { expect, it, vi } from 'vitest';
import { InventoryTextOutputSession, type InventoryTextOutput } from './inventory-text-output';
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (cause: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
function fixture() {
  let saved = '',
    output: InventoryTextOutput<string> = { kind: 'not-exported' };
  const port = {
    chooseDestination: vi.fn(async () => '/diagram.svg'),
    write: vi.fn(async (_path: string, content: string) => {
      saved = content;
    }),
    read: vi.fn(async () => saved),
  };
  const session = new InventoryTextOutputSession(
    port,
    (value: string) => value,
    'Different bytes',
    (next) => {
      output = next;
    }
  );
  return { port, session, output: () => output };
}
it('blocks a late chooser destination after disposal before any file write', async () => {
  const f = fixture(),
    choose = deferred<string | null>();
  f.port.chooseDestination.mockReturnValueOnce(choose.promise);
  const exporting = f.session.export('<svg>A</svg>', 'A.svg');
  f.session.dispose();
  choose.resolve('/late.svg');
  await exporting;
  expect(f.port.write).not.toHaveBeenCalled();
  expect(f.port.read).not.toHaveBeenCalled();
  expect(f.output()).toEqual({ kind: 'not-exported' });
});
it('restores the previous confirmed output when a later chooser is detached and ignores its late error', async () => {
  const f = fixture();
  await f.session.export('<svg>A</svg>', 'A.svg');
  const previous = f.output();
  const old = deferred<string | null>();
  f.port.chooseDestination.mockReturnValueOnce(old.promise);
  const choosing = f.session.export('<svg>B</svg>', 'B.svg');
  f.session.cancelChoosing();
  expect(f.output()).toEqual(previous);
  const current = deferred<string | null>();
  f.port.chooseDestination.mockReturnValueOnce(current.promise);
  const latest = f.session.export('<svg>C</svg>', 'C.svg');
  old.reject(Error('Old chooser'));
  await choosing;
  expect(f.output()).toEqual({ kind: 'choosing', artifact: '<svg>C</svg>' });
  current.resolve(null);
  await latest;
  expect(f.output()).toEqual(previous);
  expect(f.port.write).toHaveBeenCalledOnce();
});
it('keeps an already-begun uncertain write attached to its exact artifact and path after view detach', async () => {
  const f = fixture(),
    write = deferred<void>();
  f.port.write.mockReturnValueOnce(write.promise);
  const exporting = f.session.export('<svg>A</svg>', 'A.svg');
  await Promise.resolve();
  expect(f.output().kind).toBe('writing');
  f.session.cancelChoosing();
  write.reject(Error('Lost acknowledgement'));
  await exporting;
  expect(f.output()).toMatchObject({
    kind: 'output-unconfirmed',
    artifact: '<svg>A</svg>',
    path: '/diagram.svg',
  });
  f.port.read.mockResolvedValueOnce('<svg>A</svg>');
  await f.session.check();
  expect(f.output()).toEqual({ kind: 'exported', artifact: '<svg>A</svg>', path: '/diagram.svg' });
  expect(f.port.write).toHaveBeenCalledOnce();
});
