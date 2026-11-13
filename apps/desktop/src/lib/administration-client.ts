import { platform } from '../platform';
import type {
  AdministrationRequest,
  AdministrationResult,
  AdministrationSettings,
  AdministrationSettingsSnapshot,
} from '../shared/administration';

const listeners = new Set<(snapshot: AdministrationSettingsSnapshot) => void>();
let subscribed = false;
let snapshot: AdministrationSettingsSnapshot | null = null;
let settingsWork: Promise<unknown> = Promise.resolve();

function observe(value: AdministrationSettingsSnapshot): AdministrationSettingsSnapshot {
  if (snapshot?.ownerId === value.ownerId && snapshot.generation >= value.generation)
    return snapshot;
  snapshot = value;
  for (const listener of listeners) {
    try {
      listener(value);
    } catch {}
  }
  return value;
}

export function subscribeAdministrationSettings(
  listener: (value: AdministrationSettingsSnapshot) => void
): () => void {
  listeners.add(listener);
  if (snapshot) listener(snapshot);
  return () => listeners.delete(listener);
}

export async function executeAdministration(
  operation: AdministrationRequest['operation']
): Promise<AdministrationResult> {
  if (!subscribed) {
    const administration = platform().administration;
    if (!administration) throw new Error('Native administration is unavailable.');
    administration.onChanged((event) => {
      if (event.kind === 'settings') observe(event.snapshot);
    });
    subscribed = true;
  }
  const result = await platform().administration.execute({ operation });
  if (result.kind === 'settings') return { ...result, snapshot: observe(result.snapshot) };
  return result;
}

async function requireSettings(
  operation: AdministrationRequest['operation']
): Promise<AdministrationSettingsSnapshot> {
  const result = await executeAdministration(operation);
  if (result.kind !== 'settings')
    throw new Error(
      result.kind === 'failed'
        ? result.message
        : 'The native settings owner returned a different outcome.'
    );
  return result.snapshot;
}

export function inspectAdministrationSettings(): Promise<AdministrationSettingsSnapshot> {
  return requireSettings({ kind: 'inspect-settings' });
}

export function adoptAdministrationSettings(
  patch: Partial<AdministrationSettings>
): Promise<AdministrationSettingsSnapshot> {
  return requireSettings({ kind: 'adopt-settings', patch });
}

export function changeAdministrationSettings(
  patch: Partial<AdministrationSettings>,
  retry = false
): Promise<AdministrationSettingsSnapshot> {
  const perform = async () => {
    const current = await inspectAdministrationSettings();
    const retryAccepted =
      retry &&
      Object.entries(patch).every(
        ([key, value]) => current.values[key as keyof AdministrationSettings] === value
      );
    return requireSettings(
      retryAccepted
        ? {
            kind: 'retry-settings',
            expectedRevision: current.revision,
            keys: Object.keys(patch) as Array<keyof AdministrationSettings>,
          }
        : { kind: 'update-settings', expectedRevision: current.revision, patch }
    );
  };
  const work = settingsWork.then(perform, perform);
  settingsWork = work;
  return work;
}
