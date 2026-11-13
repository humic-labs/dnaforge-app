import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

import type {
  AgentManagedMemory as ManagedAgentMemory,
  AgentManagedMemorySaveRequest as SaveManagedAgentMemory,
  AgentManagedMemoryScope as ManagedMemoryScope,
  AgentManagedProvider as ManagedAgentProvider,
} from '../../shared/agent-capability-controls';

interface MemoryManifest {
  schemaVersion: 1;
  memory: ManagedAgentMemory[];
}

const PROVIDERS = new Set<ManagedAgentProvider>([
  'all',
  'claude-agent-sdk',
  'codex-sdk',
  'grok-acp',
]);
const SAFE_ID = /^[A-Za-z0-9_-]{1,128}$/;

function requiredText(value: unknown, label: string, maxLength: number): string {
  if (typeof value !== 'string') throw new Error(`${label} is required.`);
  const normalized = value.replace(/\r\n/g, '\n').trim();
  if (!normalized || normalized.length > maxLength) {
    throw new Error(`${label} must be between 1 and ${maxLength} characters.`);
  }
  return normalized;
}

function validateMemory(value: unknown): ManagedAgentMemory {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Agent memory store is corrupt.');
  }
  const input = value as Record<string, unknown>;
  const provider = input.provider as ManagedAgentMemory['provider'];
  const scope = input.scope as ManagedMemoryScope;
  const workspacePath = input.workspacePath;
  const conversationId = input.conversationId;
  if (
    typeof input.id !== 'string' ||
    !SAFE_ID.test(input.id) ||
    !PROVIDERS.has(provider) ||
    !['global', 'workspace', 'conversation'].includes(scope)
  ) {
    throw new Error('Agent memory store is corrupt.');
  }
  if (
    (scope === 'global' && (workspacePath !== null || conversationId !== null)) ||
    (scope === 'workspace' &&
      (typeof workspacePath !== 'string' || !workspacePath || conversationId !== null)) ||
    (scope === 'conversation' && workspacePath !== null && typeof workspacePath !== 'string') ||
    (scope === 'conversation' && (typeof conversationId !== 'string' || !conversationId))
  ) {
    throw new Error('Agent memory store is corrupt.');
  }
  if (
    typeof input.createdAt !== 'number' ||
    !Number.isFinite(input.createdAt) ||
    typeof input.updatedAt !== 'number' ||
    !Number.isFinite(input.updatedAt)
  ) {
    throw new Error('Agent memory store is corrupt.');
  }
  return {
    id: input.id,
    name: requiredText(input.name, 'Memory name', 120),
    content: requiredText(input.content, 'Memory content', 16_000),
    provider,
    scope,
    workspacePath: workspacePath as string | null,
    conversationId: conversationId as string | null,
    createdAt: input.createdAt,
    updatedAt: input.updatedAt,
  };
}

function validateManifest(value: unknown): MemoryManifest {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Agent memory store is corrupt.');
  }
  const input = value as Record<string, unknown>;
  if (input.schemaVersion !== 1 || !Array.isArray(input.memory)) {
    throw new Error('Agent memory store is corrupt.');
  }
  const memory = input.memory.map(validateMemory);
  if (new Set(memory.map((entry) => entry.id)).size !== memory.length) {
    throw new Error('Agent memory store is corrupt.');
  }
  return { schemaVersion: 1, memory };
}

export class AgentMemoryStore {
  private readonly filePath: string;
  private readonly now: () => number;
  private readonly idGenerator: () => string;
  private mutation: Promise<void> = Promise.resolve();

  constructor(options: { filePath: string; now?: () => number; idGenerator?: () => string }) {
    this.filePath = options.filePath;
    this.now = options.now ?? Date.now;
    this.idGenerator = options.idGenerator ?? randomUUID;
  }

  private async read(): Promise<MemoryManifest> {
    try {
      return validateManifest(JSON.parse(await readFile(this.filePath, 'utf8')));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return { schemaVersion: 1, memory: [] };
      }
      if (error instanceof SyntaxError) throw new Error('Agent memory store is corrupt.');
      throw error;
    }
  }

  private async write(manifest: MemoryManifest): Promise<void> {
    await mkdir(dirname(this.filePath), { recursive: true, mode: 0o700 });
    const temporaryPath = `${this.filePath}.${randomUUID()}.tmp`;
    try {
      await writeFile(temporaryPath, `${JSON.stringify(manifest, null, 2)}\n`, {
        encoding: 'utf8',
        mode: 0o600,
        flag: 'wx',
      });
      await rename(temporaryPath, this.filePath);
    } finally {
      await rm(temporaryPath, { force: true });
    }
  }

  private serialize<T>(operation: () => Promise<T>): Promise<T> {
    const next = this.mutation.then(operation, operation);
    this.mutation = next.then(
      () => undefined,
      () => undefined
    );
    return next;
  }

  async list(input: {
    workspacePath: string | null;
    conversationId: string | null;
  }): Promise<{ memory: ManagedAgentMemory[] }> {
    const manifest = await this.read();
    return {
      memory: manifest.memory.filter((entry) => {
        if (entry.scope === 'global') return true;
        if (entry.workspacePath !== input.workspacePath) return false;
        return entry.scope === 'workspace' || entry.conversationId === input.conversationId;
      }),
    };
  }

  saveMemory(input: SaveManagedAgentMemory): Promise<ManagedAgentMemory> {
    return this.serialize(async () => {
      const manifest = await this.read();
      const existing = input.id
        ? manifest.memory.find((entry) => entry.id === input.id)
        : undefined;
      if (input.id && !existing) throw new Error('This memory entry no longer exists.');
      const now = this.now();
      const memory = validateMemory({
        ...input,
        id: existing?.id ?? this.idGenerator(),
        workspacePath: input.scope === 'global' ? null : input.workspacePath,
        conversationId: input.scope === 'conversation' ? input.conversationId : null,
        createdAt: existing?.createdAt ?? now,
        updatedAt: now,
      });
      manifest.memory = [
        ...manifest.memory.filter((candidate) => candidate.id !== memory.id),
        memory,
      ];
      await this.write(manifest);
      return memory;
    });
  }

  removeMemory(id: string): Promise<void> {
    return this.serialize(async () => {
      const manifest = await this.read();
      const next = manifest.memory.filter((entry) => entry.id !== id);
      if (next.length === manifest.memory.length) {
        throw new Error('This memory entry no longer exists.');
      }
      await this.write({ ...manifest, memory: next });
    });
  }
}
