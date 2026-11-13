import { randomUUID } from 'node:crypto';

interface WorkspaceMutationSession {
  ownerId: number;
  workspaceRoot: string;
  releaseMutation: () => void;
  openTokens: number;
  activeOperations: number;
  closing: boolean;
  settled: Promise<void>;
  resolveSettled: () => void;
}

export type WorkspaceMutationReentryResult<T> = { active: true; value: T } | { active: false };

export interface RevocableWorkspaceMutationCapability {
  token: string;
  revoke(): Promise<void>;
}

export const MAX_WORKSPACE_MUTATION_TOKENS_PER_SESSION = 32;
export const MAX_WORKSPACE_MUTATION_TOKENS_PER_OWNER = 128;

export class WorkspaceMutationCapabilityRegistry {
  private readonly capabilities = new Map<string, WorkspaceMutationSession>();
  private readonly sessions = new Set<WorkspaceMutationSession>();

  issue(ownerId: number, workspaceRoot: string, releaseMutation: () => void): string {
    return this.issueSession(ownerId, workspaceRoot, releaseMutation).token;
  }

  issueRevocable(
    ownerId: number,
    workspaceRoot: string,
    releaseMutation: () => void
  ): RevocableWorkspaceMutationCapability {
    const { token, session } = this.issueSession(ownerId, workspaceRoot, releaseMutation);
    return {
      token,
      revoke: async () => {
        this.revokeSession(session);
        await session.settled;
      },
    };
  }

  private issueSession(
    ownerId: number,
    workspaceRoot: string,
    releaseMutation: () => void
  ): { token: string; session: WorkspaceMutationSession } {
    if (!Number.isSafeInteger(ownerId) || ownerId <= 0) {
      throw new Error('WORKSPACE_MUTATION_OWNER_INVALID');
    }
    if (this.tokenCountForOwner(ownerId) >= MAX_WORKSPACE_MUTATION_TOKENS_PER_OWNER) {
      throw new Error('WORKSPACE_MUTATION_OWNER_TOKEN_LIMIT');
    }
    const token = this.newToken();
    let resolveSettled = (): void => undefined;
    const settled = new Promise<void>((resolve) => {
      resolveSettled = resolve;
    });
    const session: WorkspaceMutationSession = {
      ownerId,
      workspaceRoot,
      releaseMutation,
      openTokens: 1,
      activeOperations: 0,
      closing: false,
      settled,
      resolveSettled,
    };
    this.sessions.add(session);
    this.capabilities.set(token, session);
    return { token, session };
  }

  issueReentry(parentToken: string, ownerId: number, workspaceRoot: string): string | null {
    const session = this.capabilities.get(parentToken);
    if (
      !session ||
      session.ownerId !== ownerId ||
      session.workspaceRoot !== workspaceRoot ||
      session.closing ||
      session.openTokens >= MAX_WORKSPACE_MUTATION_TOKENS_PER_SESSION ||
      this.tokenCountForOwner(ownerId) >= MAX_WORKSPACE_MUTATION_TOKENS_PER_OWNER
    ) {
      return null;
    }
    const token = this.newToken();
    session.openTokens += 1;
    this.capabilities.set(token, session);
    return token;
  }

  async runWithToken<T>(
    token: string,
    ownerId: number,
    workspaceRoot: string,
    operation: () => Promise<T>
  ): Promise<WorkspaceMutationReentryResult<T>> {
    const session = this.capabilities.get(token);
    if (
      !session ||
      session.ownerId !== ownerId ||
      session.workspaceRoot !== workspaceRoot ||
      session.closing
    ) {
      return { active: false };
    }
    session.activeOperations += 1;
    try {
      return { active: true, value: await operation() };
    } finally {
      session.activeOperations -= 1;
      this.finalizeIfIdle(session);
    }
  }

  resolveOwnedWorkspaceRoot(token: string, ownerId: number): string | null {
    const session = this.capabilities.get(token);
    if (!session || session.ownerId !== ownerId || session.closing) return null;
    return session.workspaceRoot;
  }

  release(token: string, ownerId: number): boolean {
    const session = this.capabilities.get(token);
    if (!session) return false;
    if (session.ownerId !== ownerId) throw new Error('WORKSPACE_MUTATION_TOKEN_OWNER_MISMATCH');
    this.capabilities.delete(token);
    session.openTokens -= 1;
    if (session.openTokens === 0) session.closing = true;
    this.finalizeIfIdle(session);
    return true;
  }

  releaseOwner(ownerId: number): void {
    const ownedSessions = new Set<WorkspaceMutationSession>();
    for (const [token, session] of this.capabilities) {
      if (session.ownerId !== ownerId) continue;
      this.capabilities.delete(token);
      ownedSessions.add(session);
    }
    for (const session of ownedSessions) {
      session.openTokens = 0;
      session.closing = true;
      this.finalizeIfIdle(session);
    }
  }

  hasActiveOwnerSession(ownerId: number, workspaceRoot: string): boolean {
    for (const session of this.sessions) {
      if (session.ownerId === ownerId && session.workspaceRoot === workspaceRoot) return true;
    }
    return false;
  }

  activeCountForTest(ownerId?: number): number {
    if (ownerId === undefined) return this.sessions.size;
    return [...this.sessions].filter((value) => value.ownerId === ownerId).length;
  }

  private finalizeIfIdle(session: WorkspaceMutationSession): void {
    if (!session.closing || session.openTokens > 0 || session.activeOperations > 0) return;
    if (!this.sessions.delete(session)) return;
    try {
      session.releaseMutation();
    } finally {
      session.resolveSettled();
    }
  }

  private revokeSession(session: WorkspaceMutationSession): void {
    if (session.closing && session.openTokens === 0) {
      this.finalizeIfIdle(session);
      return;
    }
    for (const [token, candidate] of this.capabilities) {
      if (candidate === session) this.capabilities.delete(token);
    }
    session.openTokens = 0;
    session.closing = true;
    this.finalizeIfIdle(session);
  }

  private tokenCountForOwner(ownerId: number): number {
    let count = 0;
    for (const session of this.capabilities.values()) {
      if (session.ownerId === ownerId) count += 1;
    }
    return count;
  }

  private newToken(): string {
    for (let attempt = 0; attempt < 8; attempt += 1) {
      const candidate = randomUUID();
      if (!this.capabilities.has(candidate)) return candidate;
    }
    throw new Error('WORKSPACE_MUTATION_TOKEN_COLLISION');
  }
}

export const workspaceMutationCapabilities = new WorkspaceMutationCapabilityRegistry();
