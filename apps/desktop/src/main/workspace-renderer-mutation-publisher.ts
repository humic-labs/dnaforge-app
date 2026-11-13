import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type {
  WorkspaceRendererMutationAppliedNotice,
  WorkspaceRendererMutationEvent,
  WorkspaceRendererMutationIdentity,
  WorkspaceRendererMutationPreparingNotice,
  WorkspaceRendererMutationRelease,
} from '../shared/workspace-renderer-mutation';
import { workspaceMutationCapabilities } from './ipc/workspace-mutation-capability';
import { workspaceMutationRootIdentity } from './workspace-sync-mutation-lease';

export interface WorkspaceRendererMutationTarget {
  id: number;
  generation?: string;
  isDestroyed(): boolean;
}
export interface WorkspaceRendererMutationPublisherDeps {
  getTarget(): WorkspaceRendererMutationTarget | null;
  send(target: WorkspaceRendererMutationTarget, event: WorkspaceRendererMutationEvent): void;
  subscribeAck(listener: (senderId: number, ack: unknown) => void): () => void;
  reloadTarget?(target: WorkspaceRendererMutationTarget): void;
  timeoutMs?: number;
  appliedTimeoutMs?: number;
  createDeliveryId?: () => string;
  warn?: (message: string) => void;
}
interface Pending {
  senderId: number;
  targetGeneration?: string;
  phase: 'preparing' | 'applied';
  timer: ReturnType<typeof setTimeout>;
  resolve(): void;
  reject(error: Error): void;
}
interface Preparation {
  targetId: number;
  targetGeneration?: string;
  notice: WorkspaceRendererMutationPreparingNotice;
  authority: string;
}
const ackSchema = z.object({
  deliveryId: z.string(),
  phase: z.enum(['preparing', 'applied']),
  status: z.enum(['ok', 'failed']),
  error: z.string().optional(),
});
class RendererMutationAckTimeoutError extends Error {}

function sourceIdentity(notice: WorkspaceRendererMutationIdentity): string {
  const source = notice.source;
  if (source.kind === 'document-command') {
    return JSON.stringify([
      workspaceMutationRootIdentity(notice.workspaceRoot),
      source.kind,
      source.actionId,
      source.documentId,
      source.sourcePath,
    ]);
  }
  return JSON.stringify([
    workspaceMutationRootIdentity(notice.workspaceRoot),
    source.kind,
    source.workspaceUuid,
    source.remoteVersionId,
  ]);
}
function preparationAuthority(notice: WorkspaceRendererMutationPreparingNotice): string {
  return JSON.stringify([
    sourceIdentity(notice),
    [...notice.affectedNotebookIds].sort(),
    [...notice.affectedDesignIds].sort(),
    [...notice.affectedEntityIds].sort(),
  ]);
}

export class WorkspaceRendererMutationPublisher {
  private readonly pending = new Map<string, Pending>();
  private readonly preparations = new Map<string, Preparation>();
  private unsubscribeAck: (() => void) | null = null;
  private closed = false;
  constructor(private readonly deps: WorkspaceRendererMutationPublisherDeps) {}

  start(): void {
    if (this.closed) throw new Error('Workspace renderer publisher stopped.');
    if (this.unsubscribeAck) return;
    this.unsubscribeAck = this.deps.subscribeAck((senderId, raw) => {
      const parsed = ackSchema.safeParse(raw);
      if (!parsed.success) return;
      const ack = parsed.data;
      const pending = this.pending.get(ack.deliveryId);
      if (!pending || pending.senderId !== senderId || pending.phase !== ack.phase) return;
      const current = this.deps.getTarget();
      if (
        !current ||
        current.isDestroyed() ||
        current.id !== pending.senderId ||
        current.generation !== pending.targetGeneration
      )
        return;
      this.settle(
        ack.deliveryId,
        pending,
        ack.status === 'failed'
          ? new Error(`Renderer ${ack.phase} failed: ${ack.error ?? 'unknown error'}`)
          : undefined
      );
    });
  }

  stop(): void {
    this.closed = true;
    this.unsubscribeAck?.();
    this.unsubscribeAck = null;
    for (const [id, pending] of this.pending)
      this.settle(id, pending, new Error('Workspace renderer publisher stopped.'));
    for (const [id, preparation] of this.preparations) {
      const target = this.targetFor(preparation);
      if (target) this.sendRelease(target, id, preparation.notice, 'needs-recovery');
    }
    this.preparations.clear();
  }

  async prepare(notice: WorkspaceRendererMutationPreparingNotice): Promise<string | null> {
    if (this.closed) throw new Error('Workspace renderer publisher stopped.');
    const target = this.deps.getTarget();
    if (!target || target.isDestroyed()) return null;
    this.start();
    const id = (this.deps.createDeliveryId ?? randomUUID)();
    if (this.preparations.has(id) || this.pending.has(id))
      throw new Error('Renderer delivery ID is already active.');
    const frozen = structuredClone(notice);
    this.preparations.set(id, {
      targetId: target.id,
      targetGeneration: target.generation,
      notice: frozen,
      authority: preparationAuthority(frozen),
    });
    try {
      await this.deliverAndWait(target, { ...frozen, deliveryId: id, phase: 'preparing' });
      return id;
    } catch (error) {
      this.abort(id, frozen, 'unchanged');
      throw error;
    }
  }

  assertPrepared(id: string, notice: WorkspaceRendererMutationPreparingNotice): void {
    if (this.closed) throw new Error('Workspace renderer publisher stopped.');
    const preparation = this.preparations.get(id);
    if (!preparation || preparation.authority !== preparationAuthority(notice)) {
      throw new Error('Workspace renderer preparation authority changed.');
    }
    if (!this.targetFor(preparation))
      throw new Error('Prepared renderer target is no longer available.');
  }

  async publish(id: string | null, notice: WorkspaceRendererMutationAppliedNotice): Promise<void> {
    if (this.closed) throw new Error('Workspace renderer publisher stopped.');
    if (!id) throw new Error('Committed mutation has no prepared renderer target.');
    const preparation = this.preparations.get(id);
    if (!preparation || preparation.authority !== preparationAuthority(notice))
      throw new Error('Workspace renderer preparation authority changed.');
    const target = this.targetFor(preparation);
    if (!target) throw new Error('Prepared renderer target is no longer available.');
    let capability: ReturnType<typeof workspaceMutationCapabilities.issueRevocable> | null = null;
    try {
      capability = workspaceMutationCapabilities.issueRevocable(
        target.id,
        workspaceMutationRootIdentity(notice.workspaceRoot),
        () => undefined
      );
      await this.deliverAndWait(target, {
        ...notice,
        deliveryId: id,
        phase: 'applied',
        mutationToken: capability.token,
      });
    } catch (error) {
      this.sendRelease(target, id, preparation.notice, 'needs-recovery');
      if (error instanceof RendererMutationAckTimeoutError) {
        try {
          this.deps.reloadTarget?.(target);
        } catch (reloadError) {
          this.deps.warn?.(`Could not reload unresponsive renderer: ${String(reloadError)}`);
        }
      }
      throw error;
    } finally {
      if (capability) await capability.revoke();
      this.preparations.delete(id);
    }
  }

  abort(
    id: string | null,
    notice: WorkspaceRendererMutationIdentity,
    disposition: WorkspaceRendererMutationRelease
  ): void {
    if (!id) return;
    const preparation = this.preparations.get(id);
    if (!preparation) return;
    if (sourceIdentity(preparation.notice) !== sourceIdentity(notice))
      throw new Error('Workspace renderer release authority changed.');
    this.preparations.delete(id);
    const target = this.targetFor(preparation);
    if (target) this.sendRelease(target, id, preparation.notice, disposition);
  }

  private targetFor(preparation: Preparation): WorkspaceRendererMutationTarget | null {
    const target = this.deps.getTarget();
    return target &&
      !target.isDestroyed() &&
      target.id === preparation.targetId &&
      target.generation === preparation.targetGeneration
      ? target
      : null;
  }
  private sendRelease(
    target: WorkspaceRendererMutationTarget,
    id: string,
    notice: WorkspaceRendererMutationIdentity,
    disposition: WorkspaceRendererMutationRelease
  ): void {
    try {
      this.deps.send(target, {
        workspaceRoot: notice.workspaceRoot,
        source: notice.source,
        deliveryId: id,
        phase: 'released',
        disposition,
      });
    } catch (error) {
      this.deps.warn?.(`Could not release workspace renderer mutation: ${String(error)}`);
    }
  }
  private async deliverAndWait(
    target: WorkspaceRendererMutationTarget,
    event: Exclude<WorkspaceRendererMutationEvent, { phase: 'released' }>
  ): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      const timeoutMs =
        this.deps.timeoutMs ??
        (event.phase === 'applied' ? (this.deps.appliedTimeoutMs ?? 30_000) : 5_000);
      const pending: Pending = {
        senderId: target.id,
        targetGeneration: target.generation,
        phase: event.phase,
        resolve,
        reject,
        timer: setTimeout(() => {
          this.deps.warn?.(
            `Renderer did not acknowledge mutation ${event.deliveryId} within ${timeoutMs}ms.`
          );
          this.settle(
            event.deliveryId,
            pending,
            new RendererMutationAckTimeoutError(
              `Renderer did not acknowledge mutation ${event.deliveryId}.`
            )
          );
        }, timeoutMs),
      };
      this.pending.set(event.deliveryId, pending);
      try {
        this.deps.send(target, event);
      } catch (error) {
        this.deps.warn?.(`Could not notify workspace renderer: ${String(error)}`);
        this.settle(
          event.deliveryId,
          pending,
          error instanceof Error ? error : new Error(String(error))
        );
      }
    });
  }
  private settle(id: string, pending: Pending, error?: Error): void {
    if (this.pending.get(id) !== pending) return;
    this.pending.delete(id);
    clearTimeout(pending.timer);
    if (error) pending.reject(error);
    else pending.resolve();
  }
}
