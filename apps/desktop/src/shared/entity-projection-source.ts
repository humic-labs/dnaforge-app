export interface EntityProjectionSourceKey {
  adapterKind: string;
  entityId: string;
  workspaceKey: string;
  relativePath: string;
  projectionVersion: number;
}

export interface SettleEntityProjectionSourceInput {
  key: EntityProjectionSourceKey;
  fingerprint: string;
}
