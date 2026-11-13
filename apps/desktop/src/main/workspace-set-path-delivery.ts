export interface WorkspaceSetPathDeliveryTarget {
  id: number;
  isDestroyed(): boolean;
}

export interface WorkspaceSetPathDelivery {
  workspacePath: string;
  deliveryId: string;
  telemetryContext?: 'managed_sync';
}

export class WorkspaceSetPathDeliveryCoordinator<Target extends WorkspaceSetPathDeliveryTarget> {
  private readonly readyTargetIds = new Set<number>();
  private readonly pendingByTargetId = new Map<number, WorkspaceSetPathDelivery>();

  constructor(
    private readonly deliver: (target: Target, delivery: WorkspaceSetPathDelivery) => void,
    private readonly createDeliveryId: () => string
  ) {}

  queue(
    target: Target,
    workspacePath: string,
    telemetryContext?: WorkspaceSetPathDelivery['telemetryContext']
  ): string {
    const delivery: WorkspaceSetPathDelivery = {
      workspacePath,
      deliveryId: this.createDeliveryId(),
      ...(telemetryContext ? { telemetryContext } : {}),
    };
    this.pendingByTargetId.set(target.id, delivery);
    this.deliverIfReady(target);
    return delivery.deliveryId;
  }

  markReady(target: Target): void {
    if (target.isDestroyed()) return;
    this.readyTargetIds.add(target.id);
    this.deliverIfReady(target);
  }

  markLoading(targetId: number): void {
    this.readyTargetIds.delete(targetId);
  }

  remove(targetId: number): void {
    this.readyTargetIds.delete(targetId);
    this.pendingByTargetId.delete(targetId);
  }

  private deliverIfReady(target: Target): void {
    if (!this.readyTargetIds.has(target.id) || target.isDestroyed()) return;
    const delivery = this.pendingByTargetId.get(target.id);
    if (!delivery) return;
    this.deliver(target, delivery);
  }
}
