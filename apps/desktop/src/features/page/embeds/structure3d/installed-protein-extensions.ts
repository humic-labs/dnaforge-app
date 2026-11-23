import { isDesktopRuntime, isHostedBrowserRuntime } from '@/utils/environment';

export interface InstalledProteinExtension {
  id: string;
  label: string;
}

interface StoredProteinExtension extends InstalledProteinExtension {
  workerSource: string;
}

const STORE = 'protein-representations';
const MAX_PACKAGE_BYTES = 8 * 1024 * 1024;
let database: Promise<IDBDatabase> | undefined;

export function supportsProteinExtensions(): boolean {
  return isDesktopRuntime() && !isHostedBrowserRuntime();
}

function openDatabase(): Promise<IDBDatabase> {
  if (!supportsProteinExtensions())
    throw new Error('Protein extensions require the DNAForge desktop app.');

  database ??= new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open('dnaforge-local-protein-extensions', 1);
    request.onupgradeneeded = () => request.result.createObjectStore(STORE, { keyPath: 'id' });
    request.onsuccess = () => {
      const db = request.result;
      db.onversionchange = () => {
        db.close();
        database = undefined;
      };
      resolve(db);
    };
    request.onerror = () => reject(request.error);
  }).catch((error) => {
    database = undefined;
    throw error;
  });
  return database;
}

async function useStore<T>(
  mode: IDBTransactionMode,
  operation: (store: IDBObjectStore) => IDBRequest<T>
): Promise<T> {
  const db = await openDatabase();
  return new Promise((resolve, reject) => {
    const transaction = db.transaction(STORE, mode);
    const request = operation(transaction.objectStore(STORE));
    transaction.oncomplete = () => resolve(request.result);
    transaction.onabort = () => reject(transaction.error ?? request.error);
    transaction.onerror = () => reject(transaction.error ?? request.error);
  });
}

export async function listInstalledProteinExtensions(): Promise<InstalledProteinExtension[]> {
  const records: StoredProteinExtension[] = await useStore('readonly', (store) => store.getAll());
  return records.map(({ id, label }) => ({ id, label }));
}

export async function installProteinExtension(file: File): Promise<InstalledProteinExtension> {
  if (file.size > MAX_PACKAGE_BYTES)
    throw new Error('This extension exceeds the 8 MiB package limit.');
  const data = JSON.parse(await file.text());
  if (
    data?.schemaVersion !== 1 ||
    data.kind !== 'protein-representation' ||
    typeof data.id !== 'string' ||
    !/^[a-z][a-z0-9-]*(?:\.[a-z][a-z0-9-]*)+$/.test(data.id) ||
    data.id.length > 120 ||
    typeof data.label !== 'string' ||
    !data.label.trim() ||
    data.label.length > 80 ||
    typeof data.workerSource !== 'string' ||
    !data.workerSource.trim()
  )
    throw new Error('This file is not a supported DNAForge protein extension.');
  const record: StoredProteinExtension = {
    id: data.id,
    label: data.label.trim(),
    workerSource: data.workerSource,
  };
  await useStore('readwrite', (store) => store.put(record));
  return { id: record.id, label: record.label };
}

export async function uninstallProteinExtension(id: string): Promise<void> {
  await useStore('readwrite', (store) => store.delete(id));
}

const RUNNER_DOCUMENT = `<!doctype html>
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'unsafe-inline'; worker-src blob:; connect-src 'none'">
<script>
addEventListener('message', (event) => {
  if (event.source !== parent || !event.ports[0]) return;
  const port = event.ports[0];
  try {
    const url = URL.createObjectURL(new Blob([event.data.source], { type: 'text/javascript' }));
    const worker = new Worker(url);
    worker.onerror = (error) => port.postMessage({ ok: false, error: error.message || 'Extension worker failed.' });
    worker.onmessageerror = () => port.postMessage({ ok: false, error: 'Invalid extension response.' });
    worker.onmessage = ({ data }) => {
      const buffers = new Set();
      for (const value of Object.values(data?.result ?? {})) {
        if (ArrayBuffer.isView(value) && value.buffer instanceof ArrayBuffer) buffers.add(value.buffer);
      }
      port.postMessage(data, Array.from(buffers));
      worker.terminate();
      URL.revokeObjectURL(url);
    };
    worker.postMessage(event.data.input);
  } catch (error) {
    port.postMessage({ ok: false, error: String(error) });
  }
}, { once: true });
</script>`;

export async function runProteinExtension(
  id: string,
  input: unknown,
  signal: AbortSignal
): Promise<unknown> {
  const extension: StoredProteinExtension | undefined = await useStore('readonly', (store) =>
    store.get(id)
  );
  signal.throwIfAborted();
  if (!extension) throw new Error('This protein extension is not installed.');
  return new Promise((resolve, reject) => {
    const frame = document.createElement('iframe');
    frame.hidden = true;
    frame.setAttribute('sandbox', 'allow-scripts');
    frame.srcdoc = RUNNER_DOCUMENT;
    const channel = new MessageChannel();
    const timeout = setTimeout(() => fail(new Error('Protein extension timed out.')), 30000);
    function cleanup() {
      clearTimeout(timeout);
      signal.removeEventListener('abort', abort);
      channel.port1.close();
      channel.port2.close();
      frame.remove();
    }
    function fail(reason: unknown) {
      cleanup();
      reject(reason);
    }
    function abort() {
      fail(signal.reason);
    }
    signal.addEventListener('abort', abort, { once: true });
    channel.port1.onmessage = ({ data }) => {
      if (data?.ok !== true)
        return fail(
          new Error(typeof data?.error === 'string' ? data.error : 'Protein extension failed.')
        );
      cleanup();
      resolve(data.result);
    };
    channel.port1.onmessageerror = () =>
      fail(new Error('Could not read protein extension output.'));
    frame.onload = () => {
      try {
        frame.contentWindow!.postMessage({ source: extension.workerSource, input }, '*', [
          channel.port2,
        ]);
      } catch (error) {
        fail(error);
      }
    };
    document.body.append(frame);
  });
}
