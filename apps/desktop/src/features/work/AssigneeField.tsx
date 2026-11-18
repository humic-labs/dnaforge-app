import { useEffect, useState } from 'react';
import type { WorkAssignee } from '@waypoint/domain-services';
import type { WorkAssigneeListing } from '../../shared/work-tasks-ipc';
import { platform } from '../../platform';
import { Button } from '../../shared/components/Button';
import { fieldClass } from './DateField';

function key(member: WorkAssignee) {
  return JSON.stringify([member.kind, member.id]);
}

export function AssigneeField({
  root,
  me,
  value,
  change,
}: {
  root: string;
  me: WorkAssignee;
  value: WorkAssignee | null;
  change(member: WorkAssignee | null): void;
}) {
  const [fetched, setFetched] = useState<{ root: string; result: WorkAssigneeListing } | null>(
    null
  );
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    if (me.kind === 'local') return;
    let active = true;
    async function load() {
      try {
        const result = await platform().workTasks.assignees({ workspaceRoot: root });
        if (active) setFetched({ root, result });
      } catch {
        if (active) setFetched({ root, result: { status: 'unavailable', members: [] } });
      }
    }
    void load();
    return () => {
      active = false;
    };
  }, [root, me.kind, me.id, attempt]);
  const listing = fetched?.root === root ? fetched.result : null;
  const members = me.kind === 'local' ? [{ principal: me, label: 'Me' }] : (listing?.members ?? []);
  const selected = value ? key(value) : '';
  const missing = value && !members.some((member) => key(member.principal) === selected);
  return (
    <div className="space-y-1">
      <label className="block text-xs font-medium">
        Assignee
        <select
          className={fieldClass}
          value={selected}
          onChange={(e) => {
            const chosen = members.find((member) => key(member.principal) === e.target.value);
            change(chosen?.principal ?? null);
          }}
        >
          <option value="">Unassigned</option>
          {missing && (
            <option value={selected} disabled>
              {key(value) === key(me) ? 'Me' : value.id}
            </option>
          )}
          {members.map((member) => (
            <option key={key(member.principal)} value={key(member.principal)}>
              {key(member.principal) === key(me) ? 'Me' : member.label}
            </option>
          ))}
        </select>
      </label>
      {me.kind === 'member' && !listing && (
        <p className="text-xs text-fg-muted">Loading project members…</p>
      )}
      {me.kind === 'member' && listing?.status === 'unavailable' && (
        <p role="status" className="text-xs text-fg-muted">
          Project members unavailable.{' '}
          <Button type="button" variant="ghost" size="xs" onClick={() => setAttempt((n) => n + 1)}>
            Retry members
          </Button>
        </p>
      )}
    </div>
  );
}
