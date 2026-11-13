import { randomUUID } from 'node:crypto';
import type { StoredSession } from './auth/session-store';

export interface HostedAiTurnIdentity {
  readonly workflowId: string;
  readonly runId: string;
  readonly turnId: string;
}

interface HostedAiTurnBinding extends HostedAiTurnIdentity {
  readonly ownerId: number;
  readonly accountId: string;
  readonly desktopSessionId: string;
  readonly workspacePath: string | null;
  readonly expiresAt: number;
  state: 'active' | 'draining';
}

interface HostedAiTurnAuthorityDependencies {
  readonly getSession: () => Promise<StoredSession | null>;
  readonly idGenerator?: () => string;
  readonly now?: () => number;
  readonly lifetimeMs?: number;
}

const DEFAULT_LIFETIME_MS = 2 * 60 * 60 * 1_000;
const MAX_BINDINGS = 256;

function sameIdentity(left: HostedAiTurnIdentity, right: HostedAiTurnIdentity): boolean {
  return (
    left.workflowId === right.workflowId &&
    left.runId === right.runId &&
    left.turnId === right.turnId
  );
}

export class HostedAiTurnAuthority {
  private readonly bindings = new Map<string, HostedAiTurnBinding>();

  constructor(private readonly deps: HostedAiTurnAuthorityDependencies) {}

  issue(
    ownerId: number,
    session: Pick<StoredSession, 'accountId' | 'desktopSessionId'>,
    identity: HostedAiTurnIdentity,
    workspacePath: string | null = null
  ): string {
    this.prune();
    if (this.bindings.size >= MAX_BINDINGS) {
      throw new Error('Too many Hosted turn bindings are active.');
    }
    const token = this.deps.idGenerator?.() ?? randomUUID();
    if (!token || token.length > 256 || this.bindings.has(token)) {
      throw new Error('Could not create a Hosted turn binding.');
    }
    this.bindings.set(token, {
      ownerId,
      accountId: session.accountId,
      desktopSessionId: session.desktopSessionId,
      ...identity,
      workspacePath,
      expiresAt: this.now() + (this.deps.lifetimeMs ?? DEFAULT_LIFETIME_MS),
      state: 'active',
    });
    return token;
  }

  async authorize(
    ownerId: number,
    token: string,
    identity: HostedAiTurnIdentity
  ): Promise<StoredSession> {
    const binding = this.bindings.get(token);
    if (!binding || binding.ownerId !== ownerId || !sameIdentity(binding, identity)) {
      throw new Error('The Hosted turn binding is invalid.');
    }
    if (binding.state !== 'active') {
      throw new Error('The Hosted turn binding is draining.');
    }
    if (binding.expiresAt <= this.now()) {
      this.bindings.delete(token);
      throw new Error('The Hosted turn binding has expired.');
    }
    const session = await this.deps.getSession();
    if (
      !session ||
      session.accountId !== binding.accountId ||
      session.desktopSessionId !== binding.desktopSessionId
    ) {
      this.bindings.delete(token);
      throw new Error('The signed-in account changed during this Hosted turn.');
    }
    return session;
  }

  beginDrain(ownerId: number, token: string, identity: HostedAiTurnIdentity): void {
    const binding = this.bindings.get(token);
    if (!binding || binding.ownerId !== ownerId || !sameIdentity(binding, identity)) {
      throw new Error('The Hosted turn binding is invalid.');
    }
    if (binding.expiresAt <= this.now()) {
      this.bindings.delete(token);
      throw new Error('The Hosted turn binding has expired.');
    }
    binding.state = 'draining';
  }

  async authorizeScope(
    ownerId: number,
    token: string,
    identity: HostedAiTurnIdentity
  ): Promise<{ readonly session: StoredSession; readonly workspacePath: string | null }> {
    const session = await this.authorize(ownerId, token, identity);
    const binding = this.bindings.get(token);
    if (!binding) throw new Error('The Hosted turn binding is invalid.');
    return { session, workspacePath: binding.workspacePath };
  }

  release(ownerId: number, token: string): void {
    if (this.bindings.get(token)?.ownerId === ownerId) this.bindings.delete(token);
  }

  revokeSession(session: {
    readonly accountId: string;
    readonly desktopSessionId: string;
  }): string[] {
    return this.revokeWhere(
      (binding) =>
        binding.accountId === session.accountId &&
        binding.desktopSessionId === session.desktopSessionId
    );
  }

  revokeExcept(
    session: {
      readonly accountId: string;
      readonly desktopSessionId: string;
    } | null
  ): string[] {
    return this.revokeWhere(
      (binding) =>
        !session ||
        binding.accountId !== session.accountId ||
        binding.desktopSessionId !== session.desktopSessionId
    );
  }

  cancelOwner(ownerId: number): void {
    for (const [token, binding] of this.bindings) {
      if (binding.ownerId === ownerId) this.bindings.delete(token);
    }
  }

  private revokeWhere(predicate: (binding: HostedAiTurnBinding) => boolean): string[] {
    const revoked: string[] = [];
    for (const [token, binding] of this.bindings) {
      if (!predicate(binding)) continue;
      this.bindings.delete(token);
      revoked.push(token);
    }
    return revoked;
  }

  private now(): number {
    return this.deps.now?.() ?? Date.now();
  }

  private prune(): void {
    const now = this.now();
    for (const [token, binding] of this.bindings) {
      if (binding.expiresAt <= now) this.bindings.delete(token);
    }
  }
}
