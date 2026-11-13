export interface DemoStore {
  read(path: readonly string[]): Promise<Uint8Array | null>;
  write(path: readonly string[], bytes: Uint8Array): Promise<void>;
  list(path: readonly string[]): Promise<string[]>;
  remove(path: readonly string[]): Promise<void>;
}

export const DEMO_SESSIONS_DIRECTORY = 'sessions';

export function createMemoryDemoStore(): DemoStore & { files: Map<string, Uint8Array> } {
  const files = new Map<string, Uint8Array>();
  const key = (path: readonly string[]) => path.join('/');
  return {
    files,
    async read(path) {
      const bytes = files.get(key(path));
      return bytes ? bytes.slice() : null;
    },
    async write(path, bytes) {
      files.set(key(path), bytes.slice());
    },
    async list(path) {
      const prefix = path.length > 0 ? `${key(path)}/` : '';
      const names = new Set<string>();
      for (const name of files.keys()) {
        if (name.startsWith(prefix)) names.add(name.slice(prefix.length).split('/')[0]);
      }
      return [...names].sort();
    },
    async remove(path) {
      const exact = key(path);
      for (const name of [...files.keys()]) {
        if (name === exact || name.startsWith(`${exact}/`)) files.delete(name);
      }
    },
  };
}

type WriteReply = { id: number; ok: true } | { id: number; ok: false; message: string };

export function createOpfsDemoStore(): DemoStore {
  let writer: Worker | null = null;
  let nextId = 0;
  const pending = new Map<number, { resolve: () => void; reject: (error: Error) => void }>();
  const worker = () => {
    if (writer) return writer;
    writer = new Worker(new URL('./demo-store.worker.ts', import.meta.url), { type: 'module' });
    writer.onmessage = (event: MessageEvent<WriteReply>) => {
      const waiter = pending.get(event.data.id);
      if (!waiter) return;
      pending.delete(event.data.id);
      if (event.data.ok) waiter.resolve();
      else waiter.reject(new Error(event.data.message));
    };
    return writer;
  };
  const directory = async (path: readonly string[], create: boolean) => {
    let current = await navigator.storage.getDirectory();
    for (const segment of path) current = await current.getDirectoryHandle(segment, { create });
    return current;
  };
  const missing = (error: unknown) =>
    error instanceof DOMException &&
    (error.name === 'NotFoundError' || error.name === 'TypeMismatchError');
  return {
    async read(path) {
      try {
        const parent = await directory(path.slice(0, -1), false);
        const handle = await parent.getFileHandle(path[path.length - 1]);
        return new Uint8Array(await (await handle.getFile()).arrayBuffer());
      } catch (error) {
        if (missing(error)) return null;
        throw error;
      }
    },
    write(path, bytes) {
      const id = (nextId += 1);
      return new Promise<void>((resolve, reject) => {
        pending.set(id, { resolve, reject });
        worker().postMessage({ id, path: [...path], bytes });
      });
    },
    async list(path) {
      try {
        const current = await directory(path, false);
        const names: string[] = [];
        for await (const name of (
          current as FileSystemDirectoryHandle & { keys(): AsyncIterable<string> }
        ).keys()) {
          names.push(name);
        }
        return names.sort();
      } catch (error) {
        if (missing(error)) return [];
        throw error;
      }
    },
    async remove(path) {
      try {
        const parent = await directory(path.slice(0, -1), false);
        await parent.removeEntry(path[path.length - 1], { recursive: true });
      } catch (error) {
        if (!missing(error)) throw error;
      }
    },
  };
}
