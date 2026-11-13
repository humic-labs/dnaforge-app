import {
  closeSync,
  fsyncSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { randomUUID } from 'node:crypto';
import { isAbsolute } from 'node:path';
import { z } from 'zod';
import { validateTerminalProfileConfiguration } from './profile-configuration';
import type { SavedTerminalSession } from './terminal-service';
import { terminalEmulationSchema } from '../../shared/terminal-runtime-policy';

const MAX_STATE_BYTES = 32_000_000;
const MAX_ENVELOPE_BYTES = 44_000_000;

export interface TerminalStateEncryption {
  isEncryptionAvailable(): boolean;
  encryptString(text: string): Buffer;
  decryptString(bytes: Buffer): string;
}

export interface AsyncTerminalStateEncryption {
  isEncryptionAvailable(): Promise<boolean>;
  encryptString(text: string): Promise<Buffer>;
  decryptString(bytes: Buffer): Promise<string>;
}

type TerminalStateEncryptionPort = TerminalStateEncryption | AsyncTerminalStateEncryption;

function withEncryptionResult<T, R>(
  result: T | Promise<T>,
  use: (value: T) => R | Promise<R>
): R | Promise<R> {
  return result instanceof Promise ? result.then(use) : use(result);
}

const envelope = z
  .object({
    version: z.literal(2),
    payload: z
      .string()
      .max(MAX_ENVELOPE_BYTES)
      .regex(/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/)
      .nullable(),
  })
  .strict();
const absolutePath = z
  .string()
  .max(32_768)
  .refine((value) => isAbsolute(value) && !value.includes('\0'));
const command = z.object({
  id: z.string().uuid().optional(),
  range: z
    .object({
      startLine: z.number().int().min(0).max(11_000),
      outputStartLine: z.number().int().min(0).max(11_000),
      endLine: z.number().int().min(0).max(11_000).optional(),
    })
    .refine(
      (range) =>
        range.startLine <= range.outputStartLine &&
        (range.endLine === undefined || range.endLine >= range.outputStartLine)
    )
    .optional(),
  command: z.string().max(8192),
  cwd: absolutePath,
  exitCode: z.number().int().nullable(),
  startedAt: z.number().finite(),
  finishedAt: z.number().finite().nullable(),
});
const session = z.object({
  id: z.string().uuid(),
  pid: z.number().int().nonnegative(),
  profileId: z.string().min(1).max(128),
  shellPath: absolutePath,
  userHome: absolutePath.optional(),
  title: z
    .string()
    .min(1)
    .max(128)
    .refine((value) => !/\p{Cc}/u.test(value)),
  cwd: absolutePath,
  cols: z.number().int().min(2).max(1000),
  rows: z.number().int().min(1).max(1000),
  exitCode: z.number().int().nullable(),
  status: z.enum(['running', 'exited']),
  integration: z.boolean(),
  alternateScreen: z.boolean(),
  shellState: z.enum(['starting', 'prompt', 'command']),
  commands: z.array(command).max(100),
  fixedDimensions: z
    .object({
      cols: z.number().int().min(2).max(1000).optional(),
      rows: z.number().int().min(1).max(1000).optional(),
    })
    .strict()
    .optional(),
  revivalError: z.string().max(8192).optional(),
  emulation: terminalEmulationSchema.optional(),
});
const savedState = z.object({
  version: z.literal(1),
  sessions: z
    .array(
      z.object({
        session,
        profile: z.unknown(),
        renamed: z.boolean(),
        replay: z.string().max(2_000_000),
        windowGroup: z.string().uuid().optional(),
      })
    )
    .max(64),
});

export function parseTerminalSavedState(text: string): SavedTerminalSession[] {
  if (Buffer.byteLength(text, 'utf8') > MAX_STATE_BYTES)
    throw new Error('Terminal saved state is too large.');
  const state = savedState.parse(JSON.parse(text));
  const ids = new Set<string>();
  return state.sessions.map((entry) => {
    if (ids.has(entry.session.id)) throw new Error('Duplicate saved terminal identity.');
    ids.add(entry.session.id);
    const profile = validateTerminalProfileConfiguration({ profiles: [entry.profile] })
      .profiles[0]!;
    if (profile.id !== entry.session.profileId || profile.path !== entry.session.shellPath)
      throw new Error('Saved terminal profile does not match its session.');
    return { ...entry, profile };
  });
}

export function readTerminalSavedState(
  path: string,
  encryption: TerminalStateEncryption,
  shouldPublish?: () => boolean
): SavedTerminalSession[];
export function readTerminalSavedState(
  path: string,
  encryption: TerminalStateEncryptionPort,
  shouldPublish?: () => boolean
): SavedTerminalSession[] | Promise<SavedTerminalSession[]>;
export function readTerminalSavedState(
  path: string,
  encryption: TerminalStateEncryptionPort,
  shouldPublish: () => boolean = () => true
): SavedTerminalSession[] | Promise<SavedTerminalSession[]> {
  try {
    const text = readFileSync(path, 'utf8');
    if (Buffer.byteLength(text, 'utf8') > MAX_ENVELOPE_BYTES)
      throw new Error('Terminal saved state is too large.');
    const parsed: unknown = JSON.parse(text);
    if (
      typeof parsed === 'object' &&
      parsed !== null &&
      'version' in parsed &&
      parsed.version === 1
    ) {
      const sessions = parseTerminalSavedState(text);

      return withEncryptionResult(
        writeTerminalSavedState(path, sessions, encryption, shouldPublish),
        () => sessions
      );
    }
    const state = envelope.parse(parsed);
    const payload = state.payload;
    if (payload === null) return [];
    return withEncryptionResult(encryption.isEncryptionAvailable(), (available) => {
      if (!available)
        throw new Error('Secure storage is unavailable; saved terminal sessions remain encrypted.');
      return withEncryptionResult(
        encryption.decryptString(Buffer.from(payload, 'base64')),
        parseTerminalSavedState
      );
    });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
}

export function writeTerminalSavedState(
  path: string,
  sessions: SavedTerminalSession[],
  encryption: TerminalStateEncryption,
  shouldPublish?: () => boolean
): void;
export function writeTerminalSavedState(
  path: string,
  sessions: SavedTerminalSession[],
  encryption: TerminalStateEncryptionPort,
  shouldPublish?: () => boolean
): void | Promise<void>;
export function writeTerminalSavedState(
  path: string,
  sessions: SavedTerminalSession[],
  encryption: TerminalStateEncryptionPort,
  shouldPublish: () => boolean = () => true
): void | Promise<void> {
  const sanitized = parseTerminalSavedState(JSON.stringify({ version: 1, sessions }));
  if (!shouldPublish()) return;
  if (sanitized.length === 0) return publishTerminalSavedState(path, null, shouldPublish);
  return withEncryptionResult(encryption.isEncryptionAvailable(), (available) => {
    if (!shouldPublish()) return;
    if (!available) {
      try {
        const previous = envelope.safeParse(JSON.parse(readFileSync(path, 'utf8')));

        if (previous.success && previous.data.payload !== null) return;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      }
      return publishTerminalSavedState(path, null, shouldPublish);
    }
    return withEncryptionResult(
      encryption.encryptString(JSON.stringify({ version: 1, sessions: sanitized })),
      (bytes) => publishTerminalSavedState(path, bytes.toString('base64'), shouldPublish)
    );
  });
}

function publishTerminalSavedState(
  path: string,
  payload: string | null,
  shouldPublish: () => boolean
): void {
  if (!shouldPublish()) return;
  const text = JSON.stringify(envelope.parse({ version: 2, payload }));
  if (Buffer.byteLength(text, 'utf8') > MAX_ENVELOPE_BYTES)
    throw new Error('Terminal saved state is too large.');
  const temporary = `${path}.${randomUUID()}.tmp`;
  let descriptor: number | undefined;
  try {
    descriptor = openSync(temporary, 'wx', 0o600);
    writeFileSync(descriptor, text, 'utf8');
    fsyncSync(descriptor);
    closeSync(descriptor);
    descriptor = undefined;
    renameSync(temporary, path);
  } finally {
    if (descriptor !== undefined) {
      try {
        closeSync(descriptor);
      } catch (error) {
        console.error('[terminal] Saved-state descriptor cleanup failed', error);
      }
    }
    try {
      unlinkSync(temporary);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT')
        console.error('[terminal] Saved-state temporary cleanup failed', error);
    }
  }
}

export class TerminalSessionCheckpoint {
  private restored = false;
  private generation = 0;

  constructor(
    private readonly path: string,
    private readonly encryption: TerminalStateEncryptionPort
  ) {}

  async restore(accept: (sessions: SavedTerminalSession[]) => Promise<void>): Promise<void> {
    const generation = ++this.generation;
    this.restored = false;
    const sessions = await readTerminalSavedState(
      this.path,
      this.encryption,
      () => generation === this.generation
    );
    if (generation !== this.generation) return;
    await accept(sessions);
    if (generation === this.generation) this.restored = true;
  }

  discard(): void {
    try {
      unlinkSync(this.path);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    this.generation += 1;
    this.restored = true;
  }

  write(sessions: SavedTerminalSession[]): void | Promise<void> {
    if (!this.restored) return;
    const generation = this.generation;
    return writeTerminalSavedState(
      this.path,
      sessions,
      this.encryption,
      () => this.restored && generation === this.generation
    );
  }
}
