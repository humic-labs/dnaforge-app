import { parseWorkspaceIdentity } from '@waypoint/domain-services';
import type {
  ScientificWorkspaceCatalog,
  ScientificWorkspaceSubmitResult,
} from '@waypoint/domain-services';
import type { PlatformBridge } from '../../platform/types';
import {
  scientificDesignSetupRequestSchema,
  type ScientificDesignSetupRequest,
} from '../../shared/scientific-design-setup';
export type ScientificDesignSetupScope = {
  projectId: string;
  workspaceRoot: string;
  workspace: string;
};
type Client = Pick<
  PlatformBridge['scientificObjects'],
  'catalog' | 'submit' | 'reconcileProjections'
>;
type StoragePort = Pick<Storage, 'getItem' | 'setItem'>;
type Phase =
  | 'inspecting'
  | 'needs-setup'
  | 'accepted-unconfirmed'
  | 'sending'
  | 'unknown'
  | 'accepted-pending'
  | 'ready'
  | 'refused'
  | 'unavailable';
type Mutation = <T>(root: string, operation: (token?: string) => Promise<T>) => Promise<T>;
export class ScientificDesignSetupSession {
  private snapshot: {
    phase: Phase;
    catalog: ScientificWorkspaceCatalog | null;
    attempt: ScientificDesignSetupRequest | null;
    result: ScientificWorkspaceSubmitResult | null;
    message: string | null;
  } = { phase: 'inspecting', catalog: null, attempt: null, result: null, message: null };
  private active = true;
  private attachments = 0;
  private generation = 0;
  private busy = false;
  private listeners = new Set<() => void>();
  private readonly key: string;
  constructor(
    readonly scope: ScientificDesignSetupScope,
    private client: Client,
    private storage: StoragePort,
    private mutation: Mutation
  ) {
    this.key = `dnaforge.scientific-design-setup.v1:${scope.workspace}`;
  }
  getSnapshot = () => this.snapshot;
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };
  activate() {
    ++this.attachments;
    this.active = true;
  }
  private set(next: Partial<typeof this.snapshot>) {
    if (!this.active) return;
    this.snapshot = { ...this.snapshot, ...next };
    for (const listener of this.listeners) listener();
  }
  private original() {
    const raw = this.storage.getItem(this.key);
    if (!raw) return null;
    const saved = JSON.parse(raw);
    if (saved.version !== 1) throw Error('The original design setup request is unavailable.');
    const input = scientificDesignSetupRequestSchema.parse(saved.input);
    if (
      input.mutationToken !== undefined ||
      input.workspaceRoot !== this.scope.workspaceRoot ||
      input.request.workspace !== this.scope.workspace ||
      input.request.operationId !== this.operationId()
    )
      throw Error('The saved design setup belongs to another project or location.');
    return input;
  }
  private operationId() {
    return `initialize-versioned-designs:${this.scope.workspace}`;
  }
  proposedRequest() {
    return scientificDesignSetupRequestSchema.parse({
      workspaceRoot: this.scope.workspaceRoot,
      request: {
        workspace: this.scope.workspace,
        operationId: this.operationId(),
        expectedHead: null,
        source: { kind: 'initialize-empty-namespace' },
      },
    });
  }
  private async catalog() {
    const result = await this.client.catalog({
      workspaceRoot: this.scope.workspaceRoot,
      request: { workspace: parseWorkspaceIdentity(this.scope.workspace) },
    });
    if (
      result.workspace !== this.scope.workspace ||
      !Array.isArray(result.entries) ||
      (result.head !== null && !/^wv_[a-f0-9]{64}$/.test(result.head))
    )
      throw Error('The design catalog does not match this project.');
    return result;
  }
  async refresh() {
    if (this.busy) return;
    const generation = ++this.generation;
    try {
      const attempt = this.original(),
        catalog = await this.catalog();
      if (!this.active || generation !== this.generation) return;
      this.set({
        attempt,
        catalog,
        phase:
          attempt && !this.snapshot.result
            ? 'unknown'
            : catalog.head
              ? this.snapshot.phase === 'ready' && catalog.head === this.snapshot.catalog?.head
                ? 'ready'
                : 'accepted-unconfirmed'
              : attempt
                ? 'unknown'
                : 'needs-setup',
        message: null,
      });
    } catch (cause) {
      if (this.active && generation === this.generation)
        this.set({ phase: 'unavailable', message: message(cause) });
    }
  }
  private retain() {
    let attempt = this.original();
    if (!attempt) {
      attempt = this.proposedRequest();
      this.storage.setItem(this.key, JSON.stringify({ version: 1, input: attempt }));
    }
    return attempt;
  }
  async setup() {
    if (this.busy) return;
    const generation = ++this.generation;
    try {
      const original = this.original();
      if (original) {
        this.set({
          attempt: original,
          phase: 'unknown',
          message: 'Retry only the original setup request.',
        });
        return;
      }
      const catalog = await this.catalog();
      if (!this.active || generation !== this.generation) return;
      if (catalog.head) {
        this.set({
          catalog,
          phase: 'accepted-unconfirmed',
          message:
            'Design history already exists. Finish its pending publication before creating designs.',
        });
        return;
      }
      const attempt = this.retain();
      this.set({ catalog, attempt });
      await this.send(attempt);
    } catch (cause) {
      if (this.active && generation === this.generation)
        this.set({ phase: 'unavailable', message: message(cause) });
    }
  }
  async retrySameSetup() {
    if (this.busy) return;
    try {
      const attempt = this.original();
      if (!attempt) throw Error('No original setup request is retained.');
      this.set({ attempt });
      await this.send(attempt);
    } catch (cause) {
      this.set({ phase: 'unavailable', message: message(cause) });
    }
  }
  private checkedResult(
    value: ScientificWorkspaceSubmitResult,
    attempt: ScientificDesignSetupRequest
  ) {
    const sha = /^wv_[a-f0-9]{64}$/;
    if (
      !value ||
      value.operationId !== attempt.request.operationId ||
      typeof value.replayed !== 'boolean' ||
      (value.currentHead !== null && !sha.test(value.currentHead)) ||
      !value.receipt ||
      !['changed', 'no-op', 'conflict', 'rejected'].includes(value.receipt.outcome)
    )
      throw Error('The original setup acknowledgement could not be confirmed.');
    if (
      value.receipt.outcome === 'conflict' &&
      (!Array.isArray(value.receipt.conflicts) || !value.receipt.conflicts.length)
    )
      throw Error('The original setup conflict acknowledgement is invalid.');
    if (
      value.receipt.outcome === 'rejected' &&
      (!value.receipt.error || typeof value.receipt.error.kind !== 'string')
    )
      throw Error('The original setup rejection acknowledgement is invalid.');
    if (value.receipt.outcome === 'changed' && !sha.test(value.receipt.version))
      throw Error('The original setup version is invalid.');
    if (
      value.receipt.outcome === 'no-op' &&
      value.receipt.head !== null &&
      !sha.test(value.receipt.head)
    )
      throw Error('The original setup head is invalid.');
    if (
      value.delivery !== null &&
      value.delivery?.kind !== 'complete' &&
      !(
        value.delivery?.kind === 'blocked' &&
        sha.test(value.delivery.versionId) &&
        typeof value.delivery.error === 'string'
      )
    )
      throw Error('The original setup delivery acknowledgement is invalid.');
    return value;
  }
  private async send(attempt: ScientificDesignSetupRequest) {
    this.busy = true;
    const generation = ++this.generation;
    this.set({ phase: 'sending', attempt, message: null });
    try {
      const result = this.checkedResult(
        await this.mutation(this.scope.workspaceRoot, (token) =>
          this.client.submit({ ...attempt, ...(token ? { mutationToken: token } : {}) })
        ),
        attempt
      );
      if (!this.active || generation !== this.generation) return;
      this.set({
        result,
        phase:
          result.receipt.outcome === 'conflict' || result.receipt.outcome === 'rejected'
            ? 'refused'
            : 'accepted-pending',
      });
      const catalog = await this.catalog();
      if (!this.active || generation !== this.generation) return;
      const accepted =
        result.receipt.outcome === 'changed'
          ? result.receipt.version
          : result.receipt.outcome === 'no-op'
            ? result.receipt.head
            : null;
      this.set({
        result,
        catalog,
        phase:
          result.receipt.outcome === 'conflict' || result.receipt.outcome === 'rejected'
            ? 'refused'
            : accepted && catalog.head && result.delivery?.kind === 'complete'
              ? 'ready'
              : 'accepted-pending',
        message: result.delivery?.kind === 'blocked' ? result.delivery.error : null,
      });
    } catch (cause) {
      if (this.active && generation === this.generation)
        this.set({
          phase:
            this.snapshot.result &&
            ['conflict', 'rejected'].includes(this.snapshot.result.receipt.outcome)
              ? 'refused'
              : this.snapshot.result &&
                  ['changed', 'no-op'].includes(this.snapshot.result.receipt.outcome)
                ? 'accepted-pending'
                : 'unknown',
          message: message(cause),
        });
    } finally {
      this.busy = false;
    }
  }
  async reconcile() {
    if (this.busy) return;
    this.busy = true;
    const generation = ++this.generation;
    this.set({ phase: 'sending', message: null });
    try {
      const result = await this.mutation(this.scope.workspaceRoot, (token) =>
        this.client.reconcileProjections({
          workspaceRoot: this.scope.workspaceRoot,
          request: { workspace: parseWorkspaceIdentity(this.scope.workspace) },
          ...(token ? { mutationToken: token } : {}),
        })
      );
      const catalog = await this.catalog();
      if (!this.active || generation !== this.generation) return;
      if (!result.head || !catalog.head)
        throw Error('Versioned design history is not available yet.');
      this.set({
        catalog,
        phase: 'ready',
        message:
          this.snapshot.attempt && !this.snapshot.result
            ? 'Design availability is confirmed. The original setup acknowledgement remains separate.'
            : null,
      });
    } catch (cause) {
      if (this.active && generation === this.generation)
        this.set({
          phase: this.snapshot.result ? 'accepted-pending' : 'accepted-unconfirmed',
          message: message(cause),
        });
    } finally {
      this.busy = false;
    }
  }
  detach() {
    this.attachments = Math.max(0, this.attachments - 1);
    if (this.attachments) return;
    this.active = false;
    ++this.generation;
  }
}
function message(cause: unknown) {
  return cause instanceof Error ? cause.message : 'Versioned design setup is unavailable.';
}
const sessions = new WeakMap<object, Map<string, ScientificDesignSetupSession>>();
export function sharedScientificDesignSetupSession(
  client: Client,
  scope: ScientificDesignSetupScope,
  storage: StoragePort,
  mutation: Mutation
) {
  let byScope = sessions.get(client);
  if (!byScope) {
    byScope = new Map();
    sessions.set(client, byScope);
  }
  const key = JSON.stringify([scope.workspace, scope.workspaceRoot]);
  let session = byScope.get(key);
  if (!session) {
    session = new ScientificDesignSetupSession(scope, client, storage, mutation);
    byScope.set(key, session);
  }
  return session;
}
