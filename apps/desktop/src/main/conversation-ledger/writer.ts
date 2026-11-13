import { createHash } from 'node:crypto';
import { appendFile, mkdir, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  CONVERSATION_LEDGER_DIRNAME,
  CONVERSATION_LEDGER_EVENTS_DIRNAME,
  CONVERSATION_LEDGER_MANIFEST_FILENAME,
  CONVERSATION_LEDGER_SCHEMA_VERSION,
} from './constants';
import {
  createConversationLedgerEnvelope,
  createConversationLedgerEventId,
  type ConversationLedgerAppendInput,
  type ConversationLedgerEvent,
} from './envelope';

export interface ConversationLedgerManifestEntry {
  conversation_id: string;
  file_name: string;
  event_count: number;
  last_event_seq: number;
  last_event_at: string | null;
}

export interface ConversationLedgerManifest {
  schema_version: typeof CONVERSATION_LEDGER_SCHEMA_VERSION;
  generated_at: string;
  conversations: ConversationLedgerManifestEntry[];
}

export interface ConversationLedgerWriterOptions {
  rootDir: string;
  now?: () => number;
  eventIdGenerator?: (nowMs: number) => string;
}

function conversationFileName(conversationId: string): string {
  return `${createHash('sha256').update(conversationId).digest('hex')}.jsonl`;
}

function parseCompleteLines(content: string): string[] {
  if (!content) return [];
  const lines = content.split('\n');
  if (content.endsWith('\n')) {
    lines.pop();
  } else {
    lines.pop();
  }
  return lines.filter((line) => line.trim().length > 0);
}

function toIso(ms: number): string {
  return new Date(ms).toISOString();
}

const NEXT_SEQUENCE_CACHE_MAX_ENTRIES = 128;

export class ConversationLedgerWriter {
  private readonly rootDir: string;
  private readonly eventsDir: string;
  private readonly manifestPath: string;
  private readonly now: () => number;
  private readonly eventIdGenerator: (nowMs: number) => string;
  private readonly queues = new Map<string, Promise<void>>();
  private readonly nextSeq = new Map<string, number>();
  private manifestQueue: Promise<unknown> = Promise.resolve();
  private manifestWriteCounter = 0;
  private manifest: ConversationLedgerManifest | null = null;

  constructor(options: ConversationLedgerWriterOptions) {
    this.rootDir = options.rootDir;
    this.eventsDir = join(this.rootDir, CONVERSATION_LEDGER_EVENTS_DIRNAME);
    this.manifestPath = join(this.rootDir, CONVERSATION_LEDGER_MANIFEST_FILENAME);
    this.now = options.now ?? Date.now;
    this.eventIdGenerator = options.eventIdGenerator ?? createConversationLedgerEventId;
  }

  static defaultRoot(userDataPath: string): string {
    return join(userDataPath, CONVERSATION_LEDGER_DIRNAME);
  }

  getConversationPath(conversationId: string): string {
    return join(this.eventsDir, conversationFileName(conversationId));
  }

  async append(input: ConversationLedgerAppendInput): Promise<ConversationLedgerEvent> {
    return this.enqueue(input.conversation_id, () => this.appendLocked(input));
  }

  async readEvents(conversationId: string): Promise<ConversationLedgerEvent[]> {
    const path = this.getConversationPath(conversationId);
    let content = '';
    try {
      content = await readFile(path, 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw error;
    }
    return parseCompleteLines(content).map((line) => JSON.parse(line) as ConversationLedgerEvent);
  }

  async rebuildManifest(): Promise<ConversationLedgerManifest> {
    return this.enqueueManifest(() => this.rebuildManifestUnlocked());
  }

  async readManifest(): Promise<ConversationLedgerManifest> {
    if (this.manifest) return this.manifest;
    return this.enqueueManifest(() => this.readManifestUnlocked());
  }

  async unlinkConversation(conversationId: string): Promise<void> {
    await this.enqueue(conversationId, async () => {
      await this.ensureDirs();
      await rm(this.getConversationPath(conversationId), { force: true });
      await this.enqueueManifest(async () => {
        const manifest = await this.readManifestUnlocked();
        manifest.conversations = manifest.conversations.filter(
          (entry) => entry.conversation_id !== conversationId
        );
        manifest.generated_at = toIso(this.now());
        this.nextSeq.delete(conversationId);
        await this.writeManifestUnlocked();
      });
    });
  }

  private async rebuildManifestUnlocked(): Promise<ConversationLedgerManifest> {
    await this.ensureDirs();
    const entries = await readdir(this.eventsDir, { withFileTypes: true });
    const conversations: ConversationLedgerManifestEntry[] = [];
    this.nextSeq.clear();

    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith('.jsonl')) continue;
      const path = join(this.eventsDir, entry.name);
      const content = await readFile(path, 'utf8').catch(() => '');
      const events = parseCompleteLines(content)
        .map((line) => {
          try {
            return JSON.parse(line) as ConversationLedgerEvent;
          } catch {
            return null;
          }
        })
        .filter((event): event is ConversationLedgerEvent => event !== null);
      if (events.length === 0) continue;

      const conversationId = events[0].conversation_id;
      const lastSeq = Math.max(...events.map((event) => event.event_seq));
      this.rememberNextSeq(conversationId, lastSeq + 1);
      conversations.push({
        conversation_id: conversationId,
        file_name: entry.name,
        event_count: events.length,
        last_event_seq: lastSeq,
        last_event_at: events[events.length - 1]?.created_at ?? null,
      });
    }

    this.manifest = {
      schema_version: CONVERSATION_LEDGER_SCHEMA_VERSION,
      generated_at: toIso(this.now()),
      conversations: conversations.sort((a, b) =>
        a.conversation_id.localeCompare(b.conversation_id)
      ),
    };
    await this.writeManifestUnlocked();
    return this.manifest;
  }

  private async readManifestUnlocked(): Promise<ConversationLedgerManifest> {
    if (this.manifest) return this.manifest;
    try {
      const parsed = JSON.parse(
        await readFile(this.manifestPath, 'utf8')
      ) as ConversationLedgerManifest;
      if (
        parsed?.schema_version === CONVERSATION_LEDGER_SCHEMA_VERSION &&
        Array.isArray(parsed.conversations)
      ) {
        this.manifest = parsed;
        return parsed;
      }
    } catch {}
    return this.rebuildManifestUnlocked();
  }

  private async appendLocked(
    input: ConversationLedgerAppendInput
  ): Promise<ConversationLedgerEvent> {
    await this.ensureDirs();
    await this.readManifest();
    const nowMs = this.now();
    const event = createConversationLedgerEnvelope(input, {
      event_id: this.eventIdGenerator(nowMs),
      event_seq: await this.allocateSeq(input.conversation_id),
      created_at: toIso(nowMs),
    });
    await appendFile(
      this.getConversationPath(input.conversation_id),
      `${JSON.stringify(event)}\n`,
      {
        encoding: 'utf8',
        mode: 0o600,
        flag: 'a',
      }
    );
    await this.upsertManifest(event);
    return event;
  }

  private async allocateSeq(conversationId: string): Promise<number> {
    const existing = this.nextSeq.get(conversationId);
    if (existing !== undefined) {
      this.rememberNextSeq(conversationId, existing + 1);
      return existing;
    }
    const events = await this.readEvents(conversationId);
    const next = events.length === 0 ? 1 : Math.max(...events.map((event) => event.event_seq)) + 1;
    this.rememberNextSeq(conversationId, next + 1);
    return next;
  }

  private rememberNextSeq(conversationId: string, nextSequence: number): void {
    this.nextSeq.delete(conversationId);
    this.nextSeq.set(conversationId, nextSequence);
    while (this.nextSeq.size > NEXT_SEQUENCE_CACHE_MAX_ENTRIES) {
      const oldestConversationId = this.nextSeq.keys().next().value;
      if (oldestConversationId === undefined) break;
      this.nextSeq.delete(oldestConversationId);
    }
  }

  private async upsertManifest(event: ConversationLedgerEvent): Promise<void> {
    await this.enqueueManifest(async () => {
      const manifest = await this.readManifestUnlocked();
      const fileName = conversationFileName(event.conversation_id);
      const index = manifest.conversations.findIndex(
        (entry) => entry.conversation_id === event.conversation_id
      );
      const current = index >= 0 ? manifest.conversations[index] : null;
      const next: ConversationLedgerManifestEntry = {
        conversation_id: event.conversation_id,
        file_name: fileName,
        event_count: (current?.event_count ?? 0) + 1,
        last_event_seq: event.event_seq,
        last_event_at: event.created_at,
      };
      if (index >= 0) {
        manifest.conversations[index] = next;
      } else {
        manifest.conversations.push(next);
        manifest.conversations.sort((a, b) => a.conversation_id.localeCompare(b.conversation_id));
      }
      manifest.generated_at = toIso(this.now());
      await this.writeManifestUnlocked();
    });
  }

  private async enqueue<T>(conversationId: string, work: () => Promise<T>): Promise<T> {
    const prior = this.queues.get(conversationId) ?? Promise.resolve();
    const next = prior.then(work);
    const queued = next
      .then(
        () => undefined,
        () => undefined
      )
      .finally(() => {
        if (this.queues.get(conversationId) === queued) {
          this.queues.delete(conversationId);
        }
      });
    this.queues.set(conversationId, queued);
    return next;
  }

  private async enqueueManifest<T>(work: () => Promise<T>): Promise<T> {
    const next = this.manifestQueue.catch(() => undefined).then(work);
    this.manifestQueue = next.catch(() => undefined);
    return next;
  }

  private async ensureDirs(): Promise<void> {
    await mkdir(this.eventsDir, { recursive: true, mode: 0o700 });
  }

  private async writeManifestUnlocked(): Promise<void> {
    if (!this.manifest) return;
    await this.ensureDirs();
    this.manifestWriteCounter += 1;
    const tempPath = `${this.manifestPath}.${process.pid}.${this.manifestWriteCounter}.tmp`;
    await writeFile(tempPath, `${JSON.stringify(this.manifest, null, 2)}\n`, {
      encoding: 'utf8',
      mode: 0o600,
    });
    await rename(tempPath, this.manifestPath);
  }
}

let defaultWriter: ConversationLedgerWriter | null = null;

export async function getDefaultConversationLedgerWriter(): Promise<ConversationLedgerWriter> {
  if (defaultWriter) return defaultWriter;
  const { app } = await import('electron');
  defaultWriter = new ConversationLedgerWriter({
    rootDir: ConversationLedgerWriter.defaultRoot(app.getPath('userData')),
  });
  return defaultWriter;
}

export async function appendConversationLedgerShadowEvent(
  input: ConversationLedgerAppendInput
): Promise<ConversationLedgerEvent | null> {
  try {
    return await (await getDefaultConversationLedgerWriter()).append(input);
  } catch (error) {
    console.warn('[ConversationLedger] Shadow append failed:', error);
    return null;
  }
}

export async function unlinkConversationLedgerShadow(conversationId: string): Promise<void> {
  try {
    await (await getDefaultConversationLedgerWriter()).unlinkConversation(conversationId);
  } catch (error) {
    console.warn('[ConversationLedger] Shadow unlink failed:', error);
  }
}
