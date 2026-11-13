import { COMPUTE_KEYRING_SERVICE, computeKeyringAccount } from '../../shared/compute-ipc';
import { deleteCredential, hasCredential, readCredential, writeCredential } from '../ipc/keyring';

const verifiedAt = new Map<string, string>();

export async function hasComputeCredential(providerId: string): Promise<boolean> {
  return hasCredential(COMPUTE_KEYRING_SERVICE, computeKeyringAccount(providerId));
}

export async function readComputeCredential(providerId: string): Promise<string | null> {
  return readCredential(COMPUTE_KEYRING_SERVICE, computeKeyringAccount(providerId));
}

export async function writeComputeCredential(providerId: string, secret: string): Promise<void> {
  await writeCredential(COMPUTE_KEYRING_SERVICE, computeKeyringAccount(providerId), secret);
}

export async function deleteComputeCredential(providerId: string): Promise<boolean> {
  const existed = await hasComputeCredential(providerId);
  verifiedAt.delete(providerId);
  await deleteCredential(COMPUTE_KEYRING_SERVICE, computeKeyringAccount(providerId));
  return existed;
}

export function recordComputeVerification(providerId: string, at: string): void {
  verifiedAt.set(providerId, at);
}

export function lastComputeVerification(providerId: string): string | null {
  return verifiedAt.get(providerId) ?? null;
}

export function resetComputeCredentialCache(): void {
  verifiedAt.clear();
}
