import { safeStorage } from 'electron';

export interface QualificationSafeStorageAudit {
  installed: true;
  attempts: number;
  methods: string[];
}

let installedAudit: QualificationSafeStorageAudit | null = null;

export function installQualificationSafeStorageGuard(
  enabled: boolean
): QualificationSafeStorageAudit | null {
  if (!enabled) return null;
  if (installedAudit) return installedAudit;

  const audit: QualificationSafeStorageAudit = { installed: true, attempts: 0, methods: [] };
  const deny = (method: string) => {
    return (..._arguments: unknown[]): never => {
      audit.attempts += 1;
      audit.methods.push(method);
      throw new Error(`QUALIFICATION_EPHEMERAL_AUTH_FORBIDS_SAFE_STORAGE:${method}`);
    };
  };
  safeStorage.isEncryptionAvailable = deny(
    'isEncryptionAvailable'
  ) as typeof safeStorage.isEncryptionAvailable;
  safeStorage.encryptString = deny('encryptString') as typeof safeStorage.encryptString;
  safeStorage.decryptString = deny('decryptString') as typeof safeStorage.decryptString;
  safeStorage.isAsyncEncryptionAvailable = async () => deny('isAsyncEncryptionAvailable')();
  safeStorage.encryptStringAsync = async () => deny('encryptStringAsync')();
  safeStorage.decryptStringAsync = async () => deny('decryptStringAsync')();
  installedAudit = audit;
  return audit;
}
