export const WORKSPACE_SYNC_DATABASE_BUSY_CODE = 'WORKSPACE_SYNC_DATABASE_BUSY';
export const WORKSPACE_SYNC_DATABASE_BUSY_MESSAGE = `${WORKSPACE_SYNC_DATABASE_BUSY_CODE}: a cloud replica is being finalized.`;

const RECONCILE_ERROR_PREFIXES = [
  'binding: ',
  'Artifact discovery failed: ',
  'Native workspace catalog reconstruction failed: ',
  'Native workspace catalog reconstruction failed after discovery: ',
] as const;

function isElectronRemoteBusyError(message: string): boolean {
  const prefix = "Error invoking remote method '";
  const separator = "': Error: ";
  if (!message.startsWith(prefix)) return false;
  const separatorIndex = message.indexOf(separator, prefix.length);
  if (separatorIndex < 0) return false;
  const channel = message.slice(prefix.length, separatorIndex);
  if (!/^[A-Za-z0-9:_-]+$/.test(channel)) return false;
  return message.slice(separatorIndex + separator.length) === WORKSPACE_SYNC_DATABASE_BUSY_MESSAGE;
}

export function isWorkspaceSyncDatabaseBusyError(error: unknown): boolean {
  let message =
    error instanceof Error ? error.message : typeof error === 'string' ? error : undefined;
  if (message === undefined) return false;
  for (const prefix of RECONCILE_ERROR_PREFIXES) {
    if (!message.startsWith(prefix)) continue;
    message = message.slice(prefix.length);
    break;
  }
  return message === WORKSPACE_SYNC_DATABASE_BUSY_MESSAGE || isElectronRemoteBusyError(message);
}
