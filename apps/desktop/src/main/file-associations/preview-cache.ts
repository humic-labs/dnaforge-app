import { randomUUID } from 'node:crypto';
import { lstat, mkdir, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

export type PreviewCacheKey = `${'sequence' | 'source'}:${string}`;
const KEY = /^(?:sequence|source):[a-f0-9]{64}$/u;
const ID = /^[a-f0-9]{64}$/u;
const DAY = 24 * 60 * 60 * 1000;

type CacheJournal = {
  version: 1;
  active: PreviewCacheKey[];
  recovery: Record<PreviewCacheKey, number>;
  idle: Record<PreviewCacheKey, number>;
};

async function size(path: string): Promise<number> {
  const entry = await lstat(path);
  if (!entry.isDirectory()) return entry.size;
  let bytes = 0;
  for (const name of await readdir(path)) bytes += await size(join(path, name));
  return bytes;
}

export class PreviewCache {
  private tail: Promise<unknown> = Promise.resolve();
  private readonly acquired = new Map<string, { sender: number; key: PreviewCacheKey }>();
  private readonly windows = new Map<number, Set<PreviewCacheKey>>();
  private journal?: CacheJournal;
  private hydrated = false;

  constructor(
    private readonly roots: { sequence: string; source: string },
    private readonly journalPath: string,
    private readonly budget: number,
    private readonly now: () => number = Date.now,
    private readonly retention = DAY
  ) {}

  run<T>(operation: () => Promise<T>): Promise<T> {
    const next = this.tail.then(async () => {
      await this.load();
      return operation();
    });
    this.tail = next.catch(() => undefined);
    return next;
  }

  private async load() {
    if (this.journal) return;
    let stored: CacheJournal = { version: 1, active: [], recovery: {}, idle: {} };
    try {
      const value = JSON.parse(await readFile(this.journalPath, 'utf8')) as CacheJournal;
      if (
        value.version !== 1 ||
        !Array.isArray(value.active) ||
        !value.active.every((key) => KEY.test(key)) ||
        [value.idle, value.recovery].some(
          (entries) =>
            !entries ||
            Array.isArray(entries) ||
            typeof entries !== 'object' ||
            Object.entries(entries).some(([key, at]) => !KEY.test(key) || !Number.isFinite(at))
        )
      )
        throw Error('The preview recovery journal is invalid.');
      stored = value;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    for (const key of stored.active) stored.recovery[key] = this.now() + this.retention;
    stored.active = [];
    this.journal = stored;
  }

  private active() {
    return new Set(
      [...this.windows.values()]
        .flatMap((set) => [...set])
        .concat([...this.acquired.values()].map((lease) => lease.key))
    );
  }

  private async persist() {
    const journal = this.journal!;
    journal.active = [...this.active()];
    const temporary = this.journalPath + '.tmp-' + randomUUID();
    await mkdir(dirname(this.journalPath), { recursive: true });
    try {
      await writeFile(temporary, JSON.stringify(journal), { flag: 'wx', mode: 0o600 });
      await rename(temporary, this.journalPath);
    } finally {
      await rm(temporary, { force: true });
    }
  }

  async acquire(sender: number, key: PreviewCacheKey) {
    const id = randomUUID();
    this.acquired.set(id, { sender, key });
    delete this.journal!.idle[key];
    try {
      await this.persist();
    } catch (error) {
      this.acquired.delete(id);
      throw error;
    }
    return id;
  }

  async release(sender: number, id: string | undefined) {
    const claim = id && this.acquired.get(id);
    if (!claim || claim.sender !== sender) return;
    this.acquired.delete(id!);
    if (!this.active().has(claim.key)) this.journal!.idle[claim.key] = this.now();
    await this.persist();
  }

  async sync(sender: number, owner: string, keys: PreviewCacheKey[]) {
    if (owner !== 'workspace-canvas') throw Error('Unknown preview tab owner.');
    const previous = this.windows.get(sender) ?? [];
    this.windows.set(sender, new Set(keys));
    const active = this.active();
    for (const key of previous) if (!active.has(key)) this.journal!.idle[key] = this.now();
    for (const key of keys) delete this.journal!.idle[key];
    this.hydrated = true;
    await this.persist();
  }

  async detach(sender: number) {
    const keys = new Set(this.windows.get(sender));
    this.windows.delete(sender);
    for (const [id, lease] of this.acquired)
      if (sender === lease.sender) {
        keys.add(lease.key);
        this.acquired.delete(id);
      }
    for (const key of keys) this.journal!.recovery[key] = this.now() + this.retention;
    await this.persist();
  }

  async packages(): Promise<Map<PreviewCacheKey, string>> {
    const found = new Map<PreviewCacheKey, string>();
    for (const family of ['sequence', 'source'] as const) {
      const root = this.roots[family];
      const entries = await readdir(root, { withFileTypes: true }).catch((error) => {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
        throw error;
      });
      for (const item of entries)
        if (item.isDirectory() && ID.test(item.name)) {
          found.set(`${family}:${item.name}`, join(root, item.name));
        }
    }
    return found;
  }

  async sweep(pressure = false, protect?: PreviewCacheKey) {
    const found = await this.packages();
    const active = this.active();
    if (protect) active.add(protect);
    const journal = this.journal!;
    const now = this.now();
    for (const [key, path] of found) {
      if (active.has(key) || !this.hydrated || (journal.recovery[key] ?? 0) > now) continue;
      if (journal.idle[key] === undefined) {
        journal.idle[key] = now;
        if (journal.recovery[key] === undefined) journal.recovery[key] = now + this.retention;
        continue;
      }
      if (pressure || now - journal.idle[key] >= this.retention) {
        await rm(path, { recursive: true });
        found.delete(key);
      }
    }
    for (const values of [journal.idle, journal.recovery])
      for (const key of Object.keys(values) as PreviewCacheKey[])
        if (!found.has(key) || (values === journal.recovery && values[key] <= now))
          delete values[key];
    await this.persist();
  }

  async admit(key: PreviewCacheKey, previouslyPresent: Set<PreviewCacheKey>) {
    let found = await this.packages();
    const total = async () =>
      (await Promise.all([...found.values()].map(size))).reduce((a, b) => a + b, 0);
    if ((await total()) <= this.budget) return;
    await this.sweep(true, key);
    found = await this.packages();
    if ((await total()) <= this.budget) return;
    const path = found.get(key);
    if (path && !previouslyPresent.has(key) && !this.active().has(key))
      await rm(path, { recursive: true });
    throw Error('Preview storage is full. Close unused previews before opening this file.');
  }
}
