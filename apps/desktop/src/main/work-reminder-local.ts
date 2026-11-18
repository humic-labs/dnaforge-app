import { randomUUID } from 'node:crypto';
import type Database from 'better-sqlite3';
import { canonicalPayload } from '@waypoint/scientific-objects';
import type {
  WorkReminderCommand,
  WorkReminderResponse,
  WorkReminderView,
} from '../shared/work-reminders-ipc';
import type { WorkProjectAccess } from './work-task-projects';
import { assertWorkProjectAtAcceptance, workProfile, workRefused } from './work-task-projects';
import { workTaskNavigationTarget } from '../shared/entity-navigation';
import { visibleWorkProjects } from './work-task-projects';
import { readWorkTask } from './work-task-store';
import {
  reminderGeneration,
  workReminderFire,
  reminderOccurrences,
  type LocalRule,
} from './work-reminder-candidates';

export interface DispatchRow {
  workspace_id: number;
  installation_id: string;
  state: 'local' | 'fenced' | 'hosted' | 'suspended';
  epoch: number;
  fence_json: string | null;
}
export interface LocalEffect {
  id: string;
  effect_key: string;
  workspace_id: number;
  task_id: string;
  rule_id: string;
  rule_generation: number;
  principal: string;
  slot: string;
  due_at: number;
  state: 'unread' | 'read' | 'snoozed' | 'dismissed' | 'hidden';
  revision: number;
  wake_at: number | null;
  created_at: number;
  channel: string;
  admitted_at: number | null;
}
interface Consent {
  inbox: number;
  desktop: number;
  revision: number;
}
export function dispatchRow(db: Database.Database, project: WorkProjectAccess) {
  return db
    .prepare('SELECT * FROM scientific_work_dispatch WHERE workspace_id=?')
    .get(project.workspaceId) as DispatchRow | undefined;
}
export function reminderPrincipal(project: WorkProjectAccess) {
  return project.actor.kind + ':' + project.actor.id;
}
function localConsent(db: Database.Database, p: WorkProjectAccess): Consent {
  return (
    (db
      .prepare(
        'SELECT inbox,desktop,revision FROM scientific_work_consent WHERE workspace_id=? AND principal=?'
      )
      .get(p.workspaceId, reminderPrincipal(p)) as Consent | undefined) ?? {
      inbox: 0,
      desktop: 0,
      revision: 0,
    }
  );
}
export function localRules(db: Database.Database, project: WorkProjectAccess, principal: string) {
  return db
    .prepare(
      'SELECT * FROM scientific_work_rules WHERE workspace_id=? AND principal=? ORDER BY rowid'
    )
    .all(project.workspaceId, principal) as LocalRule[];
}
export function localEffects(db: Database.Database, project: WorkProjectAccess, principal: string) {
  return db
    .prepare(
      'SELECT * FROM scientific_work_effects WHERE workspace_id=? AND principal=? ORDER BY created_at DESC,id'
    )
    .all(project.workspaceId, principal) as LocalEffect[];
}
const iso = (ms: number | null) => (ms === null ? null : new Date(ms).toISOString());

function effectCurrent(
  db: Database.Database,
  p: WorkProjectAccess,
  effect: LocalEffect,
  rule: LocalRule | undefined
) {
  if (!rule || rule.state !== 'armed' || rule.generation !== effect.rule_generation) return false;
  const task = readWorkTask(db, { workspaceRoot: p.root, taskId: effect.task_id });
  return (
    !!task &&
    reminderOccurrences(db, task, rule, effect.due_at, effect.due_at).some(
      (o) => o.slot === effect.slot && workReminderFire(rule, o, p.actor) === effect.due_at
    )
  );
}
export function localReminderNavigationTarget(
  db: Database.Database,
  root: string,
  effectId: string,
  epoch: number
) {
  const project = visibleWorkProjects(db, root)[0];
  if (!project || project.actor.kind !== 'local' || !project.writable) return null;
  const dispatch = dispatchRow(db, project);
  if (
    dispatch?.state !== 'local' ||
    dispatch.epoch !== epoch ||
    dispatch.installation_id !== project.actor.id
  )
    return null;
  const effect = db
    .prepare(
      "SELECT * FROM scientific_work_effects WHERE id=? AND workspace_id=? AND principal=? AND channel IN ('submit-intent','accepted')"
    )
    .get(effectId, project.workspaceId, reminderPrincipal(project)) as LocalEffect | undefined;
  if (!effect) return null;
  const rule = db
    .prepare('SELECT * FROM scientific_work_rules WHERE id=? AND workspace_id=? AND principal=?')
    .get(effect.rule_id, project.workspaceId, effect.principal) as LocalRule | undefined;
  return effectCurrent(db, project, effect, rule)
    ? workTaskNavigationTarget(project.id, effect.task_id)
    : null;
}

export function localReminderView(db: Database.Database, p: WorkProjectAccess): WorkReminderView {
  const dispatch = dispatchRow(db, p),
    consent = localConsent(db, p);
  const rules = localRules(db, p, reminderPrincipal(p));
  const byId = new Map(rules.map((r) => [r.id, r]));
  const effects = localEffects(db, p, reminderPrincipal(p));
  return {
    scope: 'local',
    available: p.writable,
    authority: dispatch?.state ?? 'unarmed',
    epoch: dispatch?.epoch ?? 0,
    consent: {
      inbox_enabled: !!consent.inbox,
      desktop_enabled: !!consent.desktop,
      email_enabled: false,
      revision: consent.revision,
    },
    rules: rules
      .filter((r) => r.state === 'armed')
      .map((r) => ({
        id: r.id,
        task_id: r.task_id,
        role: r.role,
        day_time: r.day_time,
        day_fold: r.day_fold,
        offset_ms: r.offset_ms,
        generation: r.generation,
        state: r.state,
        email_enabled: false,
        desktop_enabled: !!r.desktop_enabled,
      })),
    inbox: effects
      .filter(
        (e): e is LocalEffect & { state: Exclude<LocalEffect['state'], 'hidden'> } =>
          e.state !== 'hidden'
      )
      .map((e) => ({
        id: e.id,
        effect_key: e.effect_key,
        task_id: e.task_id,
        state: e.state,
        revision: e.revision,
        wake_at: iso(e.wake_at),
        created_at: iso(e.created_at)!,
        sourceCurrent: effectCurrent(db, p, e, byId.get(e.rule_id)),
      })),
    deliveries: effects
      .filter((e) => e.channel !== 'none')
      .map((e) => ({
        effectKey: e.effect_key,
        state: e.channel === 'unsupported' ? 'suppressed' : e.channel,
        providerId: null,
        suppressionReason:
          e.channel === 'unsupported'
            ? 'System notifications unavailable'
            : e.channel === 'suppressed'
              ? 'Consent or schedule changed'
              : null,
        admittedAt: iso(e.admitted_at),
      })),
    subscriptions: [],
  };
}

export function changeLocalReminder(
  db: Database.Database,
  p: WorkProjectAccess,
  requestId: string,
  cmd: WorkReminderCommand,
  now: number
): WorkReminderResponse {
  const principal = reminderPrincipal(p),
    json = canonicalPayload(cmd),
    local = workProfile(db);
  const receipt = db
    .prepare(
      'SELECT command_json,result_json FROM scientific_work_reminder_receipts WHERE workspace_id=? AND principal=? AND request_id=?'
    )
    .get(p.workspaceId, principal, requestId) as
    | { command_json: string; result_json: string }
    | undefined;
  if (receipt) {
    if (receipt.command_json !== json)
      return workRefused('This reminder request identity was reused.');
    return JSON.parse(receipt.result_json) as WorkReminderResponse;
  }
  const dispatch = dispatchRow(db, p);
  if (p.actor.kind !== 'local' || (dispatch && dispatch.installation_id !== local.id))
    return workRefused('This device does not own the reminder schedule.');
  const task =
    cmd.action === 'rule' ? readWorkTask(db, { workspaceRoot: p.root, taskId: cmd.taskId }) : null;
  return db
    .transaction(() => {
      assertWorkProjectAtAcceptance(db, p, false);
      let result: WorkReminderResponse = {};
      if (cmd.action === 'consent') {
        if (cmd.email) workRefused('Email delivery requires shared scheduling.');
        const old = localConsent(db, p);
        if (old.revision !== cmd.expectedRevision) workRefused('Reminder consent changed.');
        const rev = old.revision + 1;
        if (
          Boolean(old.inbox) !== cmd.inbox ||
          (cmd.desktop !== undefined && Boolean(old.desktop) !== cmd.desktop)
        ) {
          db.prepare(
            'UPDATE scientific_work_rules SET scanned_at=max(scanned_at,?) WHERE workspace_id=? AND principal=?'
          ).run(now, p.workspaceId, principal);
        }
        if (cmd.desktop === false)
          db.prepare(
            "UPDATE scientific_work_effects SET channel='suppressed' WHERE workspace_id=? AND principal=? AND channel='queued'"
          ).run(p.workspaceId, principal);
        db.prepare(
          'INSERT INTO scientific_work_consent VALUES(?,?,?,?,?) ON CONFLICT(workspace_id,principal) DO UPDATE SET inbox=excluded.inbox,desktop=excluded.desktop,revision=excluded.revision'
        ).run(
          p.workspaceId,
          principal,
          +cmd.inbox,
          Number(cmd.desktop ?? Boolean(old.desktop)),
          rev
        );
        result = { revision: rev };
      } else if (cmd.action === 'rule') {
        const consent = localConsent(db, p);
        if (!p.writable) workRefused('Local task reminders require a writable project.');
        if (
          (dispatch && dispatch.state !== 'local') ||
          !task ||
          !['todo', 'in-progress'].includes(task.document.status)
        )
          workRefused('The task or local dispatch authority is unavailable.');
        if (cmd.email || (!consent.inbox && !(consent.desktop && cmd.desktop)))
          workRefused('Enable the requested delivery channel before arming this rule.');
        if (
          task.document.assignee &&
          (task.document.assignee.kind !== p.actor.kind || task.document.assignee.id !== p.actor.id)
        )
          workRefused('This task is assigned to someone else.');
        const date = task.schedule[cmd.role];
        if (
          ((date.kind === 'resolved' && date.value.kind === 'day') ||
            task.document.recurrence?.anchor.kind === 'day') &&
          !cmd.dayTime
        )
          workRefused('Choose the local alert time for this calendar day.');
        if (date.kind !== 'resolved' && !(cmd.role === 'start' && task.document.recurrence))
          workRefused('Choose a resolved task date.');
        if (!dispatch)
          db.prepare("INSERT INTO scientific_work_dispatch VALUES(?,?,'local',1,NULL)").run(
            p.workspaceId,
            local.id
          );
        const id = cmd.ruleId ?? randomUUID();
        if (db.prepare('SELECT 1 FROM scientific_work_rules WHERE id=?').get(id))
          workRefused('This rule identity already exists.');
        db.prepare("INSERT INTO scientific_work_rules VALUES(?,?,?,?,?,?,?,?,?,1,'armed',?)").run(
          id,
          p.workspaceId,
          principal,
          cmd.taskId,
          cmd.role,
          cmd.offsetMs,
          cmd.dayTime ?? null,
          cmd.dayFold ?? 'earlier',
          Number(cmd.desktop ?? false),
          now
        );
        result = { id, state: 'armed' };
      } else if (cmd.action === 'retire-rule') {
        const updated = db
          .prepare(
            "UPDATE scientific_work_rules SET state='retired',generation=generation+1 WHERE id=? AND workspace_id=? AND principal=? AND state='armed' AND generation=?"
          )
          .run(cmd.ruleId, p.workspaceId, principal, cmd.expectedGeneration);
        if (!updated.changes) workRefused('Reminder rule changed.');
        result = { id: cmd.ruleId, state: 'retired' };
      } else if (cmd.action === 'inbox') {
        const wake = cmd.state === 'snoozed' ? Date.parse(cmd.wakeAt ?? '') : null;
        if (wake !== null && (!Number.isFinite(wake) || wake <= now))
          workRefused('Choose a future snooze time.');
        const updated = db
          .prepare(
            "UPDATE scientific_work_effects SET state=?,wake_at=?,revision=revision+1 WHERE id=? AND workspace_id=? AND principal=? AND revision=? AND state!='hidden'"
          )
          .run(cmd.state, wake, cmd.id, p.workspaceId, principal, cmd.expectedRevision);
        if (!updated.changes) workRefused('The inbox item changed.');
        result = { id: cmd.id, state: cmd.state, revision: cmd.expectedRevision + 1 };
      } else if (cmd.action === 'suspend' || cmd.action === 'rearm') {
        if (
          !dispatch ||
          dispatch.epoch !== cmd.expectedEpoch ||
          dispatch.state !== (cmd.action === 'suspend' ? 'local' : 'suspended') ||
          !p.writable
        )
          workRefused('Reminder authority changed.');
        const state = cmd.action === 'suspend' ? 'suspended' : 'local';
        db.prepare(
          'UPDATE scientific_work_dispatch SET state=?,epoch=epoch+1 WHERE workspace_id=?'
        ).run(state, p.workspaceId);
        if (cmd.action === 'rearm')
          db.prepare('UPDATE scientific_work_rules SET scanned_at=? WHERE workspace_id=?').run(
            now,
            p.workspaceId
          );
        result = { state, epoch: dispatch!.epoch + 1 };
      } else return workRefused('This command requires a shared project.');
      db.prepare('INSERT INTO scientific_work_reminder_receipts VALUES(?,?,?,?,?)').run(
        p.workspaceId,
        principal,
        requestId,
        json,
        canonicalPayload(result)
      );
      return result;
    })
    .immediate();
}

export function scanLocalWorkReminders(
  db: Database.Database,
  p: WorkProjectAccess,
  now: number,
  notify: (effect: LocalEffect, epoch: number) => void
) {
  const principal = reminderPrincipal(p);
  if (p.actor.kind !== 'local') return;
  const dispatch = dispatchRow(db, p);
  if (dispatch?.state !== 'local' || dispatch.installation_id !== p.actor.id || !p.writable) return;
  const consent = localConsent(db, p);
  const rules = localRules(db, p, principal).filter((r) => r.state === 'armed');
  db.prepare(
    "UPDATE scientific_work_effects SET state='unread',wake_at=NULL,revision=revision+1 WHERE workspace_id=? AND principal=? AND state='snoozed' AND wake_at<=?"
  ).run(p.workspaceId, principal, now);
  for (const rule of rules) {
    const through = Math.min(now, rule.scanned_at + 7 * 86400000);
    if (through < rule.scanned_at) continue;
    const task = readWorkTask(db, { workspaceRoot: p.root, taskId: rule.task_id });
    const occurrences = task ? reminderOccurrences(db, task, rule, rule.scanned_at, through) : [];
    db.transaction(() => {
      for (const occurrence of occurrences) {
        const due = workReminderFire(rule, occurrence, p.actor);
        if (due === null || due < rule.scanned_at || due > through) continue;
        const key = canonicalPayload([
          p.id,
          task!.id,
          occurrence.slot,
          rule.id,
          rule.generation,
          reminderGeneration(due, p.actor.id, rule),
          p.actor.id,
        ]);
        const channel = rule.desktop_enabled ? (consent.desktop ? 'queued' : 'suppressed') : 'none';
        db.prepare(
          'INSERT INTO scientific_work_effects(id,effect_key,workspace_id,principal,task_id,rule_id,rule_generation,slot,due_at,task_revision,state,revision,created_at,channel) VALUES(?,?,?,?,?,?,?,?,?,?,?,1,?,?) ON CONFLICT(effect_key) DO NOTHING'
        ).run(
          randomUUID(),
          key,
          p.workspaceId,
          principal,
          rule.task_id,
          rule.id,
          rule.generation,
          occurrence.slot,
          due,
          task!.revisionId,
          consent.inbox ? 'unread' : 'hidden',
          now,
          channel
        );
      }
      db.prepare('UPDATE scientific_work_rules SET scanned_at=? WHERE id=?').run(through, rule.id);
    }).immediate();
  }
  const byId = new Map(rules.map((r) => [r.id, r]));
  for (const effect of localEffects(db, p, principal).filter((e) => e.channel === 'queued')) {
    const allowed = consent.desktop && effectCurrent(db, p, effect, byId.get(effect.rule_id));
    const updated = db
      .transaction(() => {
        assertWorkProjectAtAcceptance(db, p, false);
        return db
          .prepare(
            "UPDATE scientific_work_effects SET channel=?,admitted_at=? WHERE id=? AND channel='queued' AND EXISTS(SELECT 1 FROM scientific_work_dispatch WHERE workspace_id=? AND state='local' AND epoch=?)"
          )
          .run(
            allowed ? 'submit-intent' : 'suppressed',
            now,
            effect.id,
            p.workspaceId,
            dispatch.epoch
          );
      })
      .immediate();
    if (updated.changes && allowed) notify(effect, dispatch.epoch);
  }
}
