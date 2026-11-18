import { DesktopSyncClientError } from './desktop-sync-client-errors';
import { randomUUID } from 'node:crypto';
import type Database from 'better-sqlite3';
import { canonicalPayload } from '@waypoint/scientific-objects';
import type {
  WorkReminderCommand,
  WorkReminderResponse,
  WorkReminderView,
} from '../shared/work-reminders-ipc';
import { createDesktopSyncClient, type DesktopSyncClient } from './desktop-sync-client';
import {
  workProfile,
  workRefused,
  assertWorkProjectAtAcceptance,
  type WorkProjectAccess,
} from './work-task-projects';
import { readWorkspaceSyncAccessBinding } from './workspace-sync-access-record';
import { withWorkspaceSyncDatabaseFence } from './workspace-sync-database-fence';
import { dispatchRow, localEffects, localRules } from './work-reminder-local';
import { reminderGeneration } from './work-reminder-candidates';

interface RemoteView extends Omit<WorkReminderView, 'authority' | 'epoch' | 'available' | 'scope'> {
  handoffOffers?: { id: string; epoch: number }[];
  dispatch: {
    state: 'unarmed' | 'hosted' | 'suspended';
    epoch: number;
    source_installation_id: string | null;
    local_fence_id: string | null;
  } | null;
}
function binding(db: Database.Database, p: WorkProjectAccess) {
  const row = readWorkspaceSyncAccessBinding(db, p.registeredId);
  if (
    p.actor.kind !== 'member' ||
    !row?.remote_workspace_id ||
    row.detached_reason !== null ||
    row.owner_account_id !== p.actor.id
  )
    return workRefused('The shared reminder service is unavailable for this project.');
  return row.remote_workspace_id;
}
export function remoteWorkReminderClient(
  db: Database.Database,
  p: WorkProjectAccess,
  client: DesktopSyncClient = createDesktopSyncClient()
) {
  const id = binding(db, p);
  const path = '/api/desktop-sync/workspaces/' + encodeURIComponent(id) + '/work-dates';
  const verify = () => {
    assertWorkProjectAtAcceptance(db, p, false);
    if (binding(db, p) !== id) workRefused('The shared project binding changed.');
  };
  const read = async (): Promise<RemoteView> => {
    const value = await client.requestJson<RemoteView>(path, {
      method: 'GET',
      expectedAccountId: p.actor.id,
    });
    await withWorkspaceSyncDatabaseFence(db, async () => verify());
    if (
      !value ||
      !Array.isArray(value.rules) ||
      !Array.isArray(value.inbox) ||
      !Array.isArray(value.deliveries) ||
      !Array.isArray(value.subscriptions)
    )
      throw new Error('Shared reminder response is incomplete.');
    return value;
  };
  const post = async (requestId: string, command: object) => {
    await withWorkspaceSyncDatabaseFence(db, async () => verify());
    const value = await client.requestJson<WorkReminderResponse>(path, {
      method: 'POST',
      expectedAccountId: p.actor.id,
      body: { requestId, command },
      idempotencyKey: requestId,
    });
    try {
      await withWorkspaceSyncDatabaseFence(db, async () => verify());
    } catch {
      throw new Error(
        'The shared reminder acknowledgement cannot be returned to the current account.'
      );
    }
    return value;
  };
  return { id, read, post, verify };
}
export async function runRemoteReminderCommand(
  db: Database.Database,
  p: WorkProjectAccess,
  remote: ReturnType<typeof remoteWorkReminderClient>,
  requestId: string,
  command: object
) {
  const serialized = canonicalPayload(command),
    principal = 'member:' + p.actor.id;
  const previous = await withWorkspaceSyncDatabaseFence(db, async () =>
    db
      .transaction(() => {
        remote.verify();
        const row = db
          .prepare(
            'SELECT command_json,result_json FROM scientific_work_reminder_receipts WHERE workspace_id=? AND principal=? AND request_id=?'
          )
          .get(p.workspaceId, principal, requestId) as
          | { command_json: string; result_json: string }
          | undefined;
        if (row) {
          if (row.command_json !== serialized)
            return workRefused('This reminder request identity was reused.');
          return JSON.parse(row.result_json) as {
            pending?: boolean;
            response?: WorkReminderResponse;
            error?: string;
          };
        }
        db.prepare('INSERT INTO scientific_work_reminder_receipts VALUES(?,?,?,?,?)').run(
          p.workspaceId,
          principal,
          requestId,
          serialized,
          '{"pending":true}'
        );
        return null;
      })
      .immediate()
  );
  if (previous?.response) return previous.response;
  if (previous?.error) return workRefused(previous.error);
  const settle = async (value: object) =>
    withWorkspaceSyncDatabaseFence(db, async () => {
      db.prepare(
        'UPDATE scientific_work_reminder_receipts SET result_json=? WHERE workspace_id=? AND principal=? AND request_id=?'
      ).run(canonicalPayload(value), p.workspaceId, principal, requestId);
    });
  let response;
  try {
    response = await remote.post(requestId, command);
  } catch (error) {
    if (
      error instanceof DesktopSyncClientError &&
      [400, 401, 403, 404, 409, 422].includes(error.status ?? 0)
    ) {
      if (previous?.pending)
        throw new Error('The shared service cannot confirm an earlier request.');
      await settle({ error: error.message });
    }
    throw error;
  }
  const { url, ...safe } = response;
  await settle({ response: { ...safe, ...(url ? { secretUnavailable: true } : {}) } });
  return response;
}

type RemotePort = ReturnType<typeof remoteWorkReminderClient>;
interface Fence {
  requestId: string;
  expectedEpoch: number;
  installationId: string;
  accountId: string;
  remoteId: string;
  fenceId: string;
  offerRequestId: string;
  rules: { requestId: string; command: Extract<WorkReminderCommand, { action: 'rule' }> }[];
  ledger: {
    taskId: string;
    ruleId: string;
    ruleGeneration: number;
    accountId: string;
    slot: string;
    generation: string;
    disposition: 'accepted' | 'uncertain' | 'suppressed' | 'materialized';
  }[];
}

export async function readRemoteWorkReminders(
  db: Database.Database,
  p: WorkProjectAccess,
  remote = remoteWorkReminderClient(db, p)
): Promise<WorkReminderView> {
  const row = dispatchRow(db, p);
  const frozen =
    row?.fence_json && row.state === 'fenced' ? (JSON.parse(row.fence_json) as Fence) : null;
  const pending =
    frozen && frozen.accountId === p.actor.id
      ? { pendingHandoff: { requestId: frozen.requestId, expectedEpoch: frozen.expectedEpoch } }
      : {};
  let value: RemoteView;
  try {
    value = await remote.read();
  } catch {
    return withWorkspaceSyncDatabaseFence(db, async () => {
      remote.verify();
      return {
        scope: 'shared',
        ...pending,
        authority: row?.state === 'fenced' ? 'fenced' : 'unarmed',
        available: false,
        epoch: row?.epoch ?? 0,
        consent: null,
        rules: [],
        inbox: [],
        deliveries: [],
        subscriptions: [],
      };
    });
  }
  const state = value.dispatch?.state ?? 'unarmed';
  return {
    scope: 'shared',
    ...pending,
    offers: (value.handoffOffers ?? []).map(({ id, epoch }) => ({ id, epoch })),
    available: true,
    authority: row?.state === 'fenced' && state !== 'hosted' ? 'fenced' : state,
    epoch: value.dispatch?.epoch ?? 0,
    consent: value.consent,
    rules: value.rules,
    inbox: value.inbox,
    deliveries: value.deliveries,
    subscriptions: value.subscriptions,
  };
}

function prepareFence(
  db: Database.Database,
  p: WorkProjectAccess,
  remote: RemotePort,
  requestId: string,
  expectedEpoch: number
): Fence {
  remote.verify();
  const old = dispatchRow(db, p),
    device = workProfile(db).id;
  if (old?.fence_json) {
    const previous = JSON.parse(old.fence_json) as Fence;
    if (
      previous.requestId !== requestId ||
      previous.expectedEpoch !== expectedEpoch ||
      previous.accountId !== p.actor.id ||
      previous.remoteId !== remote.id ||
      previous.installationId !== device
    )
      return workRefused('Retry the original handoff from its owning installation.');
    return previous;
  }
  if (old && old.installation_id !== device)
    return workRefused('Only the originating installation may fence its reminders.');
  const rules = localRules(db, p, 'local:' + device);
  const active = rules.filter((rule) => rule.state === 'armed');
  const byId = new Map(active.map((rule) => [rule.id, rule]));
  const fence: Fence = {
    requestId,
    expectedEpoch,
    remoteId: remote.id,
    installationId: device,
    accountId: p.actor.id,
    fenceId: randomUUID(),
    offerRequestId: randomUUID(),
    rules: active.map((rule) => ({
      requestId: randomUUID(),
      command: {
        action: 'rule',
        ruleId: rule.id,
        taskId: rule.task_id,
        role: rule.role,
        offsetMs: rule.offset_ms,
        dayTime: rule.day_time,
        dayFold: rule.day_fold,
        email: false,
      },
    })),
    ledger: localEffects(db, p, 'local:' + device).flatMap((effect) => {
      const rule = byId.get(effect.rule_id);
      if (!rule || rule.generation !== effect.rule_generation) return [];
      const disposition =
        effect.channel === 'accepted'
          ? 'accepted'
          : effect.channel === 'submit-intent' || effect.channel === 'uncertain'
            ? 'uncertain'
            : effect.channel === 'suppressed'
              ? 'suppressed'
              : 'materialized';
      return [
        {
          taskId: rule.task_id,
          ruleId: rule.id,
          ruleGeneration: rule.generation,
          accountId: p.actor.id,
          slot: effect.slot,
          generation: reminderGeneration(effect.due_at, p.actor.id, rule),
          disposition,
        },
      ];
    }),
  };
  db.prepare(
    "INSERT INTO scientific_work_dispatch VALUES(?,?,'fenced',?,?) ON CONFLICT(workspace_id) DO UPDATE SET state='fenced',epoch=excluded.epoch,fence_json=excluded.fence_json"
  ).run(p.workspaceId, device, (old?.epoch ?? 0) + 1, canonicalPayload(fence));
  return fence;
}

export async function handoffWorkReminders(
  db: Database.Database,
  p: WorkProjectAccess,
  requestId: string,
  expectedEpoch: number,
  remote = remoteWorkReminderClient(db, p)
) {
  const fence = await withWorkspaceSyncDatabaseFence(db, async () =>
    db.transaction(() => prepareFence(db, p, remote, requestId, expectedEpoch)).immediate()
  );
  for (const rule of fence.rules) await remote.post(rule.requestId, rule.command);
  const payload = {
    expectedEpoch,
    sourceInstallationId: fence.installationId,
    localFenceId: fence.fenceId,
    ledger: fence.ledger,
  };
  const offer = await remote.post(fence.offerRequestId, { action: 'offer-handoff', ...payload });
  if (offer.id !== fence.offerRequestId)
    throw new Error('The shared service has not acknowledged the local fence offer.');
  const result = await remote.post(requestId, {
    action: 'handoff',
    expectedEpoch,
    sourceOfferId: offer.id,
  });
  if (result.state !== 'hosted')
    throw new Error('The shared service has not acknowledged reminder ownership.');
  await withWorkspaceSyncDatabaseFence(db, async () => {
    remote.verify();
    db.prepare(
      "UPDATE scientific_work_dispatch SET state='hosted' WHERE workspace_id=? AND json_extract(fence_json,'$.requestId')=?"
    ).run(p.workspaceId, requestId);
  });
  return result;
}
