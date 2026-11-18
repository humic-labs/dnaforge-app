import { useState } from 'react';
import type { WorkTaskRecord, WorkProject } from '../../shared/work-tasks-ipc';
import { Button } from '../../shared/components/Button';
import { fieldClass } from './DateField';
import { useWorkReminders } from './use-work-reminders';
import { useWorkQuery } from './use-work-query';
import { openWorkTask } from './task-presentation';

function Recovery({ service }: { service: ReturnType<typeof useWorkReminders> }) {
  return (
    <>
      {service.error && (
        <p role="alert" className="text-xs text-error">
          {service.error}
        </p>
      )}
      {service.pending && (
        <p className="text-xs text-fg-muted">
          This request needs its saved reply.{' '}
          <Button type="button" disabled={service.busy} onClick={() => void service.retry()}>
            Retry request
          </Button>
        </p>
      )}
    </>
  );
}

export function WorkTaskReminders({ task }: { task: WorkTaskRecord }) {
  const service = useWorkReminders(task.project.root);
  const [role, setRole] = useState<'start' | 'deadline'>('deadline');
  const [minutes, setMinutes] = useState(0);
  const [time, setTime] = useState('09:00');
  const [url, setUrl] = useState('');
  const [linkNotice, setLinkNotice] = useState('');
  const [fold, setFold] = useState<'earlier' | 'later'>('earlier');
  const view = service.view;
  const disabled = service.busy || service.blocked || !!service.pending || !view?.available;
  return (
    <details className="space-y-2 border-t border-border pt-3 text-xs" data-testid="task-reminders">
      <summary className="cursor-pointer font-medium">Reminders and calendar</summary>
      <Recovery service={service} />
      {view ? (
        <>
          <p className="text-fg-muted">
            {view.scope === 'local'
              ? 'Reminders on this device run while DNAForge is open.'
              : 'Shared reminders use your account preferences.'}
          </p>
          {view.authority === 'fenced' && (
            <p className="text-fg-muted">
              Reminders are paused while shared scheduling is confirmed.
            </p>
          )}
          <fieldset disabled={disabled} className="space-y-2">
            <label className="flex items-center gap-2">
              <input
                type="checkbox"
                checked={view.consent?.inbox_enabled ?? false}
                onChange={(e) =>
                  void service.run({
                    action: 'consent',
                    expectedRevision: view.consent?.revision ?? 0,
                    inbox: e.target.checked,
                    desktop: view.consent?.desktop_enabled ?? false,
                    email: view.consent?.email_enabled ?? false,
                  })
                }
              />
              In-app reminders
            </label>
            {view.scope === 'local' ? (
              <label className="flex items-center gap-2">
                <input
                  type="checkbox"
                  checked={view.consent?.desktop_enabled ?? false}
                  onChange={(e) =>
                    void service.run({
                      action: 'consent',
                      expectedRevision: view.consent?.revision ?? 0,
                      inbox: view.consent?.inbox_enabled ?? false,
                      desktop: e.target.checked,
                      email: false,
                    })
                  }
                />
                Desktop notifications
              </label>
            ) : (
              <label className="flex items-center gap-2">
                <input
                  type="checkbox"
                  checked={view.consent?.email_enabled ?? false}
                  onChange={(e) =>
                    void service.run({
                      action: 'consent',
                      expectedRevision: view.consent?.revision ?? 0,
                      inbox: view.consent?.inbox_enabled ?? false,
                      email: e.target.checked,
                    })
                  }
                />
                Email reminders
              </label>
            )}
            {view.rules
              .filter((rule) => rule.task_id === task.id && rule.state === 'armed')
              .map((rule) => (
                <div key={rule.id} className="flex items-center justify-between gap-2">
                  <span>
                    {rule.offset_ms / 60000} minutes before{' '}
                    {rule.role === 'start' ? 'planned time' : 'deadline'}
                    {rule.day_time ? ` · ${rule.day_time} on all-day dates` : ''}
                  </span>
                  <Button
                    type="button"
                    onClick={() =>
                      void service.run({
                        action: 'retire-rule',
                        ruleId: rule.id,
                        expectedGeneration: rule.generation,
                      })
                    }
                  >
                    Remove reminder
                  </Button>
                </div>
              ))}
            {task.document.status !== 'done' && task.document.status !== 'canceled' && (
              <div className="grid grid-cols-2 gap-2">
                <label>
                  Remind before
                  <select
                    aria-label="Reminder date"
                    className={fieldClass}
                    value={role}
                    onChange={(e) => setRole(e.target.value as typeof role)}
                  >
                    <option value="deadline">Deadline</option>
                    <option value="start">Planned time</option>
                  </select>
                </label>
                <label>
                  Minutes before
                  <input
                    aria-label="Reminder minutes before"
                    type="number"
                    min="0"
                    max="527040"
                    className={fieldClass}
                    value={minutes}
                    onChange={(e) => setMinutes(Number(e.target.value))}
                  />
                </label>
                <label>
                  Time on all-day dates
                  <input
                    aria-label="All-day reminder time"
                    type="time"
                    className={fieldClass}
                    value={time}
                    onChange={(e) => setTime(e.target.value)}
                  />
                </label>
                <Button
                  type="button"
                  onClick={() =>
                    void service.run({
                      action: 'rule',
                      ruleId: crypto.randomUUID(),
                      taskId: task.id,
                      role,
                      offsetMs: minutes * 60000,
                      dayTime: time || null,
                      dayFold: fold,
                      email: view.consent?.email_enabled ?? false,
                      desktop: view.consent?.desktop_enabled ?? false,
                    })
                  }
                >
                  Add reminder
                </Button>
              </div>
            )}
            <label className="block">
              When the selected clock time occurs twice
              <select
                className={fieldClass}
                aria-label="Reminder clock change"
                value={fold}
                onChange={(event) => setFold(event.target.value as typeof fold)}
              >
                <option value="earlier">First occurrence</option>
                <option value="later">Second occurrence</option>
              </select>
            </label>
            {view.scope === 'shared' && view.canOfferHandoff && view.authority !== 'hosted' && (
              <Button
                type="button"
                onClick={() => void service.run({ action: 'handoff', expectedEpoch: view.epoch })}
              >
                Offer shared reminders
              </Button>
            )}
            {view.scope === 'shared' &&
              view.canAcceptHandoff &&
              view.offers?.map((offer) => (
                <Button
                  key={offer.id}
                  type="button"
                  onClick={() =>
                    void service.run({
                      action: 'handoff',
                      expectedEpoch: offer.epoch,
                      sourceOfferId: offer.id,
                    })
                  }
                >
                  Accept shared reminders
                </Button>
              ))}
            {view.scope === 'local' && view.authority === 'suspended' && (
              <Button
                type="button"
                onClick={() => void service.run({ action: 'rearm', expectedEpoch: view.epoch })}
              >
                Resume future reminders
              </Button>
            )}
            {view.authority === 'local' || view.authority === 'hosted' ? (
              <Button
                type="button"
                onClick={() => void service.run({ action: 'suspend', expectedEpoch: view.epoch })}
              >
                Pause project reminders
              </Button>
            ) : null}
            {view.deliveries.length > 0 && (
              <details>
                <summary className="cursor-pointer text-fg-muted">Recent delivery outcomes</summary>
                <ul className="space-y-1">
                  {view.deliveries.slice(0, 10).map((delivery) => (
                    <li key={delivery.effectKey}>
                      {delivery.state === 'uncertain'
                        ? 'Delivery outcome unknown. It will not be automatically resent.'
                        : delivery.state === 'accepted'
                          ? 'Accepted by the notification service'
                          : delivery.state === 'rejected'
                            ? 'Notification declined'
                            : delivery.state === 'suppressed'
                              ? 'Reminder stopped'
                              : delivery.state === 'unsupported'
                                ? 'Desktop notifications unavailable'
                                : delivery.state === 'submit-intent'
                                  ? 'Submitting notification'
                                  : 'Waiting to send'}
                      {delivery.suppressionReason ? ' · ' + delivery.suppressionReason : ''}
                    </li>
                  ))}
                </ul>
              </details>
            )}
            {view.scope === 'shared' && (
              <div className="space-y-2 border-t border-border pt-2">
                <p>Subscribe to this project's planned work and deadlines in a calendar app.</p>
                <Button
                  type="button"
                  onClick={() =>
                    void service
                      .run({
                        action: 'calendar-issue',
                        roles: ['plan', 'deadline'],
                        expiresAt: new Date(Date.now() + 180 * 86400000).toISOString(),
                      })
                      .then((result) => {
                        if (result?.url) setUrl(result.url);
                        if (result?.secretUnavailable)
                          setLinkNotice('Replace the calendar link to get a new private address.');
                      })
                  }
                >
                  Create calendar link
                </Button>
                {url && (
                  <label className="block">
                    Private calendar link
                    <input
                      readOnly
                      aria-label="Private calendar link"
                      className={fieldClass}
                      value={url}
                    />
                    <span>
                      Anyone with this link can read this calendar until it expires or you revoke
                      it.
                    </span>
                  </label>
                )}
                {linkNotice && <p role="status">{linkNotice}</p>}
                {view.subscriptions
                  .filter((s) => s.state === 'active')
                  .map((s) => (
                    <div className="flex items-center gap-2" key={s.id}>
                      <span>Expires {new Date(s.expires_at).toLocaleDateString()}</span>
                      <Button
                        type="button"
                        onClick={() =>
                          void service
                            .run({
                              action: 'calendar-rotate',
                              id: s.id,
                              expectedGeneration: s.generation,
                            })
                            .then((result) => {
                              if (result?.url) setUrl(result.url);
                            })
                        }
                      >
                        Replace link
                      </Button>
                      <Button
                        type="button"
                        onClick={() =>
                          void service.run({
                            action: 'calendar-revoke',
                            id: s.id,
                            expectedGeneration: s.generation,
                          })
                        }
                      >
                        Revoke link
                      </Button>
                    </div>
                  ))}
              </div>
            )}
          </fieldset>
        </>
      ) : (
        !service.error && <p>Loading reminder settings…</p>
      )}
    </details>
  );
}

function ProjectInbox({ project, tasks }: { project: WorkProject; tasks: WorkTaskRecord[] }) {
  const service = useWorkReminders(project.root);
  const rows =
    service.view?.inbox.filter((row) => row.state === 'unread' || row.state === 'snoozed') ?? [];
  return (
    <div className="space-y-2 text-xs">
      <h3 className="font-medium">{project.name}</h3>
      <Recovery service={service} />
      {!rows.length && service.view && <p className="text-fg-muted">No unread reminders.</p>}
      {rows.map((row) => (
        <div
          key={row.id}
          className="flex flex-wrap items-center gap-2 rounded border border-border p-2"
        >
          <button
            type="button"
            className="min-w-0 flex-1 text-left text-accent"
            onClick={() => openWorkTask({ workspaceRoot: project.root, taskId: row.task_id })}
          >
            {tasks.find((task) => task.id === row.task_id)?.document.name ?? 'Task reminder'}
          </button>
          {!row.sourceCurrent && <span className="text-fg-muted">Schedule changed</span>}
          {row.state === 'snoozed' && (
            <span className="text-fg-muted">
              Snoozed until {row.wake_at ? new Date(row.wake_at).toLocaleString() : 'later'}
            </span>
          )}
          <Button
            type="button"
            disabled={service.busy || !!service.pending}
            onClick={() =>
              void service.run({
                action: 'inbox',
                id: row.id,
                expectedRevision: row.revision,
                state: 'read',
              })
            }
          >
            Mark read
          </Button>
          <Button
            type="button"
            disabled={service.busy || !!service.pending}
            onClick={() =>
              void service.run({
                action: 'inbox',
                id: row.id,
                expectedRevision: row.revision,
                state: 'snoozed',
                wakeAt: new Date(Date.now() + 3600000).toISOString(),
              })
            }
          >
            Snooze 1 hour
          </Button>
          <Button
            type="button"
            disabled={service.busy || !!service.pending}
            onClick={() =>
              void service.run({
                action: 'inbox',
                id: row.id,
                expectedRevision: row.revision,
                state: 'dismissed',
              })
            }
          >
            Dismiss
          </Button>
        </div>
      ))}
    </div>
  );
}

export function WorkInbox() {
  const { result } = useWorkQuery({ state: 'active', assignee: 'me' });
  return (
    <details
      aria-label="Reminders"
      className="space-y-3"
      data-analytics-block="true"
      data-testid="work-inbox"
    >
      <summary className="cursor-pointer text-sm font-semibold">Reminders</summary>
      {result?.projects.map((project) => (
        <ProjectInbox
          key={project.id}
          project={project}
          tasks={result.tasks.filter((task) => task.project.id === project.id)}
        />
      ))}
    </details>
  );
}
