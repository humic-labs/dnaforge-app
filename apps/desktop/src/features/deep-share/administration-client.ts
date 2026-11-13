import { executeAdministration } from '../../lib/administration-client';
import { platform } from '../../platform';
import type { AdministrationAction } from '../../shared/administration';
import type {
  DeepSharePublishResult,
  DeepShareSelectionRequest,
} from '../../shared/deep-share-ipc';

function locator(accountId: string, selection: DeepShareSelectionRequest): string {
  return `native-share-action:${JSON.stringify([accountId, selection.workspaceUuid, selection.rootArtifactId])}`;
}

function readLocator(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}
function writeLocator(key: string, id: string | null): void {
  try {
    if (id) localStorage.setItem(key, id);
    else localStorage.removeItem(key);
  } catch {}
}

export async function prepareShareAdministration(
  accountId: string,
  selection: DeepShareSelectionRequest,
  reuse: boolean
): Promise<AdministrationAction> {
  const key = locator(accountId, selection);
  const previous = readLocator(key);
  if (previous) {
    const inspection = await executeAdministration({ kind: 'inspect-action', actionId: previous });
    if (inspection.kind === 'action') {
      if (
        ['unresolved', 'executing', 'awaiting-human'].includes(inspection.action.state) ||
        (reuse && inspection.action.state === 'completed')
      )
        return inspection.action;
      if (inspection.action.state === 'prepared')
        await executeAdministration({
          kind: 'cancel-action',
          actionId: previous,
          expectedRevision: inspection.action.revision,
        });
    }
    writeLocator(key, null);
  }
  const result = await executeAdministration({ kind: 'prepare-share', selection });
  if (result.kind !== 'action')
    throw Object.assign(
      new Error(
        result.kind === 'failed'
          ? result.message
          : 'The native share owner did not prepare this selection.'
      ),
      { code: result.kind === 'failed' ? result.code : 'PUBLISH_FAILED' }
    );
  writeLocator(key, result.action.id);
  return result.action;
}

export function waitForShareAdministration(
  id: string,
  signal?: AbortSignal
): Promise<AdministrationAction> {
  return new Promise((resolve, reject) => {
    let settled = false;
    let inspecting = false;
    let dirty = false;
    let unsubscribe = () => {};
    const finish = (value?: AdministrationAction, error?: unknown) => {
      if (settled) return;
      settled = true;
      unsubscribe();
      signal?.removeEventListener('abort', aborted);
      if (error) reject(error);
      else if (value) resolve(value);
    };
    const inspect = async () => {
      if (settled) return;
      if (inspecting) {
        dirty = true;
        return;
      }
      inspecting = true;
      try {
        const result = await executeAdministration({ kind: 'inspect-action', actionId: id });
        if (result.kind !== 'action')
          throw new Error(
            result.kind === 'failed' ? result.message : 'The native share action is unavailable.'
          );
        if (!['awaiting-human', 'executing'].includes(result.action.state)) finish(result.action);
      } catch (error) {
        finish(undefined, error);
      } finally {
        inspecting = false;
        if (dirty) {
          dirty = false;
          void inspect();
        }
      }
    };
    const aborted = () =>
      finish(
        undefined,
        new Error('Share observation ended. Inspect this same native action to resume.')
      );
    unsubscribe = platform().administration.onChanged((event) => {
      if (event.kind === 'action' && event.action.id === id) void inspect();
    });
    signal?.addEventListener('abort', aborted, { once: true });
    if (signal?.aborted) aborted();
    else void inspect();
  });
}

export async function publishShareAdministration(
  action: AdministrationAction,
  signal?: AbortSignal
): Promise<DeepSharePublishResult> {
  let current = action;
  if (current.state === 'prepared') {
    const result = await executeAdministration({
      kind: 'execute-action',
      actionId: current.id,
      expectedRevision: current.revision,
    });
    if (result.kind !== 'action')
      throw new Error(
        result.kind === 'failed' ? result.message : 'The native owner could not execute this share.'
      );
    current = result.action;
  }
  if (current.state === 'awaiting-human' || current.state === 'executing')
    current = await waitForShareAdministration(current.id, signal);
  if (current.result && 'ok' in current.result) return current.result;
  return {
    ok: false,
    code: current.state === 'stale' ? 'MANIFEST_STALE' : 'PUBLISH_FAILED',
    message:
      current.message ??
      'The share was not published. Inspect the retained native action before retrying.',
  };
}

export async function cancelShareAdministration(action: AdministrationAction): Promise<void> {
  const result = await executeAdministration({ kind: 'inspect-action', actionId: action.id });
  if (result.kind === 'action' && ['prepared', 'awaiting-human'].includes(result.action.state))
    await executeAdministration({
      kind: 'cancel-action',
      actionId: action.id,
      expectedRevision: result.action.revision,
    });
}

export function acknowledgeShareLink(
  accountId: string,
  selection: DeepShareSelectionRequest
): void {
  writeLocator(locator(accountId, selection), null);
}
