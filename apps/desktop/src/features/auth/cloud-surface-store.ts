export type SettingsEntry = 'organizations' | 'account' | 'usage-analytics' | 'registry';

type CloudSurfaceListener = (open: boolean) => void;

let listener: CloudSurfaceListener | null = null;
const settingsEntryListeners = new Set<(entry: SettingsEntry) => void>();
const projectSharingListeners = new Set<(open: boolean) => void>();

export function subscribeCloudSurface(fn: CloudSurfaceListener): () => void {
  listener = fn;
  return () => {
    if (listener === fn) listener = null;
  };
}

export function openCloudSurface(): void {
  listener?.(true);
}

export function subscribeSettingsEntry(fn: (entry: SettingsEntry) => void): () => void {
  settingsEntryListeners.add(fn);
  return () => {
    settingsEntryListeners.delete(fn);
  };
}

export function openSettingsEntry(entry: SettingsEntry): void {
  for (const fn of settingsEntryListeners) fn(entry);
}

export function subscribeOrganizationsSettings(fn: () => void): () => void {
  return subscribeSettingsEntry((entry) => {
    if (entry === 'organizations') fn();
  });
}

export function openOrganizationsSettings(): void {
  openSettingsEntry('organizations');
}

export function openAccountSettings(): void {
  openSettingsEntry('account');
}

export function subscribeProjectSharing(fn: (open: boolean) => void): () => void {
  projectSharingListeners.add(fn);
  return () => {
    projectSharingListeners.delete(fn);
  };
}

export function openProjectSharing(): void {
  for (const fn of projectSharingListeners) fn(true);
}
