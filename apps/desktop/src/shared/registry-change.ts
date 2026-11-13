export interface LimsRegistrationChangedDetail {
  documentId?: string | null;
  filePath?: string | null;
  entityId?: string | null;
}
export type RegistryChangeEmitter = (detail?: LimsRegistrationChangedDetail) => void;
