export const PROJECTION_FINGERPRINT_MISMATCH =
  'Entity projection equality fingerprint does not match its canonical file.';

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
