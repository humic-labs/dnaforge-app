interface WriteRequest {
  id: number;
  path: string[];
  bytes: Uint8Array;
}

interface SyncAccessHandle {
  truncate(size: number): void;
  write(buffer: Uint8Array, options: { at: number }): number;
  flush(): void;
  close(): void;
}

let queue: Promise<void> = Promise.resolve();

async function write({ path, bytes }: WriteRequest): Promise<void> {
  let directory = await navigator.storage.getDirectory();
  for (const segment of path.slice(0, -1)) {
    directory = await directory.getDirectoryHandle(segment, { create: true });
  }
  const file = await directory.getFileHandle(path[path.length - 1], { create: true });
  const handle = await (
    file as FileSystemFileHandle & { createSyncAccessHandle(): Promise<SyncAccessHandle> }
  ).createSyncAccessHandle();
  try {
    handle.truncate(0);
    handle.write(bytes, { at: 0 });
    handle.flush();
  } finally {
    handle.close();
  }
}

self.onmessage = (event: MessageEvent<WriteRequest>) => {
  const request = event.data;
  queue = queue
    .then(() => write(request))
    .then(
      () => self.postMessage({ id: request.id, ok: true }),
      (error: unknown) =>
        self.postMessage({
          id: request.id,
          ok: false,
          message: error instanceof Error ? error.message : String(error),
        })
    );
};
