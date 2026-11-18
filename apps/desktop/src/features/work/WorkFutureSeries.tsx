import { useEffect, useRef, useState } from 'react';
import { workDatePart } from '@waypoint/domain-services';
import { parseWorkTime } from '@waypoint/scientific-objects';
import { platform } from '../../platform';
import { Button } from '../../shared/components/Button';
import type {
  WorkTaskRecord,
  WorkTaskSplitRequest,
  WorkTaskSplitResult,
} from '../../shared/work-tasks-ipc';
import { fieldClass } from './DateField';
import { RecurrenceEditor } from './RecurrenceEditor';
import { buildRecurrence, describeDate, recurrenceDraft, type RecurrenceDraft } from './task-form';
import { useWorkAccount } from './use-work-query';
import { WORK_TASK_CHANGED } from './task-presentation';

interface Props {
  record: WorkTaskRecord;
  editable: boolean;
  onAccepted?(result: WorkTaskSplitResult): void;
}
type Editor = { firstSlot: string; replacement: RecurrenceDraft; revision: string };
type DraftEntry = { draft: Editor; operationId?: string };

function readDraft(key: string): DraftEntry | null {
  const raw = localStorage.getItem(key);
  if (raw === null) return null;
  const entry = JSON.parse(raw),
    draft = entry?.draft,
    rule = draft?.replacement,
    anchor = rule?.anchor;
  const folds = ['', 'earlier', 'later'];
  if (
    !draft ||
    typeof draft.revision !== 'string' ||
    !draft.revision.trim() ||
    typeof draft.firstSlot !== 'string' ||
    (entry.operationId !== undefined && typeof entry.operationId !== 'string') ||
    !rule ||
    !['daily', 'weekly', 'monthly'].includes(rule.frequency) ||
    rule.state !== 'active' ||
    !['interval', 'count', 'until'].every((key) => typeof rule[key] === 'string') ||
    !folds.includes(rule.fold) ||
    !Array.isArray(rule.weekdays) ||
    !rule.weekdays.every(
      (day: unknown) => typeof day === 'number' && Number.isInteger(day) && day >= 1 && day <= 7
    ) ||
    (rule.excludedSlots !== undefined &&
      (!Array.isArray(rule.excludedSlots) ||
        !rule.excludedSlots.every((day: unknown) => typeof day === 'string'))) ||
    !anchor ||
    !['date', 'time', 'zone'].every((key) => typeof anchor[key] === 'string') ||
    !folds.includes(anchor.fold) ||
    anchor.relative !== undefined ||
    (anchor.retained !== undefined && parseWorkTime(anchor.retained).kind !== 'timed')
  )
    throw new Error('The saved series draft could not be read.');
  return entry;
}

function fetchPending(prefix: string, record: WorkTaskRecord): WorkTaskSplitRequest[] {
  return Object.keys(localStorage)
    .filter((key) => key.startsWith(prefix))
    .map((key) => {
      const stored = JSON.parse(localStorage.getItem(key)!);
      if (
        !stored ||
        key !== prefix + stored.operationId ||
        stored.workspaceRoot !== record.project.root ||
        stored.taskId !== record.id ||
        typeof stored.successorId !== 'string' ||
        !stored.replacement
      )
        throw new Error('A saved series change could not be read.');
      return stored;
    });
}
function detail(cause: unknown) {
  return cause instanceof Error ? cause.message : String(cause);
}
function initialEditor(record: WorkTaskRecord): Editor {
  const replacement = recurrenceDraft(record.document.recurrence);
  return {
    firstSlot: '',
    replacement: { ...replacement, state: 'active', anchor: { ...replacement.anchor, date: '' } },
    revision: record.revisionId,
  };
}

export function WorkFutureSeries(props: Props) {
  const account = useWorkAccount();
  const { record } = props;
  const scope = JSON.stringify([
    account,
    record.project.actor?.kind,
    record.project.actor?.id,
    record.project.id,
    record.project.root,
    record.id,
  ]);
  return (
    <FutureEditor
      key={scope}
      {...props}
      prefix={'work-series-split-v1/' + scope + '/'}
      draftKey={'work-series-draft-v1/' + scope}
    />
  );
}

function FutureEditor({
  record,
  editable,
  onAccepted,
  prefix,
  draftKey,
}: Props & { prefix: string; draftKey: string }) {
  const [draft, setDraft] = useState<Editor | null>(null);
  const [pending, setPending] = useState<WorkTaskSplitRequest[]>([]);
  const [accepted, setAccepted] = useState<{
    name: string;
    start: string;
    delivery: string;
  } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [conflictRevision, setConflictRevision] = useState<string>();
  const [storageError, setStorageError] = useState(false);
  const flight = useRef(false);
  const mounted = useRef(true);
  const lastDraft = useRef<string | null>(null);
  const rule = record.document.recurrence;
  const relative = [
    record.document.plan?.start,
    record.document.plan?.end,
    record.document.deadline,
  ].some((field) => field?.kind === 'relative');
  const active =
    !!rule && rule.state === 'active' && !['done', 'canceled'].includes(record.document.status);
  function readRecovery() {
    try {
      setPending(fetchPending(prefix, record));
      const saved = readDraft(draftKey);
      lastDraft.current = saved && JSON.stringify(saved);
      setDraft(saved?.draft ?? null);
      setStorageError(false);
    } catch (cause) {
      setError('Could not read series recovery. ' + detail(cause));
      setStorageError(true);
    }
  }
  function revise(next: Editor | null, operationId?: string) {
    try {
      const saved = readDraft(draftKey);
      if ((saved && JSON.stringify(saved)) !== lastDraft.current) {
        readRecovery();
        setError('The saved draft changed in another window. Check it before continuing.');
        return false;
      }
      const raw = next && JSON.stringify({ draft: next, ...(operationId ? { operationId } : {}) });
      if (raw === null) localStorage.removeItem(draftKey);
      else localStorage.setItem(draftKey, raw);
      lastDraft.current = raw;
      setDraft(next);
      setError('');
      return true;
    } catch (cause) {
      setError('Could not save the series draft. ' + detail(cause));
      setStorageError(true);
      return false;
    }
  }
  useEffect(() => {
    mounted.current = true;
    readRecovery();
    const observe = (event: StorageEvent) => {
      if (!event.key || event.key === draftKey || event.key.startsWith(prefix)) readRecovery();
    };
    window.addEventListener('storage', observe);
    return () => {
      mounted.current = false;
      window.removeEventListener('storage', observe);
    };
  }, [prefix, draftKey]);
  async function send(request: WorkTaskSplitRequest, retry: boolean) {
    if (flight.current) return;
    flight.current = true;
    setBusy(true);
    setError('');
    const key = prefix + request.operationId;
    let sent = false;
    let confirmation: WorkTaskSplitResult | undefined;
    try {
      localStorage.setItem(key, JSON.stringify(request));
      readRecovery();
      sent = true;
      const result = await platform().workTasks.split(request);
      const receipt = result.submission.receipt;
      if (receipt.outcome === 'conflict' || receipt.outcome === 'rejected') {
        localStorage.removeItem(key);
        if (!mounted.current) return;
        readRecovery();
        if (receipt.outcome === 'conflict') setConflictRevision(request.expectedRevisionId);
        setError(
          receipt.outcome === 'conflict'
            ? 'The series changed before this split was accepted. Reopen the current rule to try again.'
            : 'Series change refused · ' + receipt.error.kind
        );
        return;
      }
      if (
        !result.successor ||
        !result.task ||
        result.successor.id !== request.successorId ||
        result.task.id !== request.taskId
      )
        throw new Error('The accepted series could not be confirmed.');
      try {
        if (readDraft(draftKey)?.operationId === request.operationId)
          localStorage.removeItem(draftKey);
        localStorage.removeItem(key);
      } catch (cause) {
        if (mounted.current)
          setError('The series was saved. Could not clear its recovery record. ' + detail(cause));
      }
      window.dispatchEvent(new Event(WORK_TASK_CHANGED));
      if (!mounted.current) return;
      readRecovery();
      setAccepted({
        start: describeDate(request.replacement.anchor),
        name: result.successor.document.name,
        delivery: result.submission.delivery?.kind ?? 'pending',
      });
      confirmation = result;
    } catch (cause) {
      if (!mounted.current) return;
      const reason = detail(cause);
      if (!sent) {
        readRecovery();
        setError('Could not keep the retry details. ' + reason);
        return;
      }
      if (
        !retry &&
        (reason.includes('WORK_TASK_REFUSED:') || reason.includes('WORK_TASK_CONFLICT:'))
      ) {
        localStorage.removeItem(key);
        readRecovery();
        if (reason.includes('WORK_TASK_CONFLICT:')) setConflictRevision(request.expectedRevisionId);
        setError(reason);
      } else {
        readRecovery();
        setError('The split outcome needs confirmation. Check the original request. ' + reason);
      }
    } finally {
      flight.current = false;
      if (mounted.current) setBusy(false);
    }
    if (confirmation) onAccepted?.(confirmation);
  }
  function split() {
    if (
      !draft ||
      !rule ||
      !editable ||
      !active ||
      relative ||
      busy ||
      draft.revision !== record.revisionId ||
      draft.revision === conflictRevision ||
      storageError
    )
      return;
    try {
      const saved = fetchPending(prefix, record);
      if (saved.length) {
        setPending(saved);
        return;
      }
      if (!draft.firstSlot || draft.firstSlot < workDatePart(rule.anchor))
        throw new Error('Choose an occurrence from the original series.');
      if (!draft.replacement.anchor.date || draft.replacement.anchor.date < draft.firstSlot)
        throw new Error('The new series must start on or after the chosen occurrence.');
      const replacement = buildRecurrence({
        ...draft.replacement,
        anchor: { ...draft.replacement.anchor, fold: draft.replacement.fold },
      });
      if (!replacement) throw new Error('Choose a repeat rule for the new series.');
      const operationId = crypto.randomUUID();
      if (!revise(draft, operationId)) return;
      void send(
        {
          workspaceRoot: record.project.root,
          taskId: record.id,
          operationId,
          successorId: crypto.randomUUID(),
          expectedRevisionId: draft.revision,
          firstSlot: draft.firstSlot,
          replacement,
        },
        false
      );
    } catch (cause) {
      setError(detail(cause));
    }
  }
  if (!rule && !draft && !pending.length && !storageError) return null;
  return (
    <section
      className="space-y-2 text-xs"
      aria-label="Change future occurrences"
      data-testid="work-future-series"
    >
      {pending.length > 0 ? (
        pending.map((request) => (
          <div key={request.operationId} className="space-y-1 rounded border border-border p-2">
            <p>
              Pending change from {request.firstSlot} · {request.replacement.frequency}
            </p>
            <Button
              type="button"
              size="xs"
              variant="secondary"
              disabled={busy || storageError || record.project.writable === false}
              onClick={() => void send(request, true)}
            >
              Check split outcome
            </Button>
          </div>
        ))
      ) : draft && rule ? (
        <div className="space-y-2 rounded border border-border p-3">
          <p>Earlier occurrences and saved exceptions stay with this task.</p>
          <fieldset
            disabled={
              !editable ||
              busy ||
              storageError ||
              draft.revision !== record.revisionId ||
              draft.revision === conflictRevision
            }
            className="space-y-2"
          >
            <label className="block">
              First original occurrence to change
              <input
                type="date"
                className={fieldClass}
                min={workDatePart(rule.anchor)}
                value={draft.firstSlot}
                onChange={(e) => {
                  const date = e.target.value;
                  revise({
                    ...draft,
                    firstSlot: date,
                    replacement: {
                      ...draft.replacement,
                      anchor: {
                        ...draft.replacement.anchor,
                        date:
                          !draft.replacement.anchor.date ||
                          draft.replacement.anchor.date === draft.firstSlot
                            ? date
                            : draft.replacement.anchor.date,
                      },
                    },
                  });
                }}
              />
            </label>
            <RecurrenceEditor
              future
              saved={null}
              start={draft.replacement.anchor}
              value={draft.replacement}
              change={(replacement) => revise({ ...draft, replacement })}
            />
            <Button
              type="button"
              size="xs"
              variant="secondary"
              disabled={!draft.firstSlot || !active || relative || storageError}
              onClick={split}
            >
              Apply to this and future occurrences
            </Button>
          </fieldset>
          {draft.revision !== record.revisionId && (
            <p role="status">
              The rule changed.{' '}
              <Button
                type="button"
                size="xs"
                variant="ghost"
                onClick={() => {
                  revise(initialEditor(record));
                }}
              >
                Load current rule
              </Button>
            </p>
          )}
          <Button
            type="button"
            size="xs"
            variant="ghost"
            disabled={busy || storageError}
            onClick={() => revise(null)}
          >
            Cancel series change
          </Button>
        </div>
      ) : (
        active && (
          <Button
            type="button"
            size="xs"
            variant="secondary"
            disabled={
              !editable || relative || storageError || record.revisionId === conflictRevision
            }
            onClick={() => {
              if (revise(initialEditor(record))) setAccepted(null);
            }}
          >
            Change future occurrences
          </Button>
        )
      )}
      {draft && !rule && !pending.length && (
        <div>
          <p>The saved draft belongs to an earlier repeat rule.</p>
          <Button
            type="button"
            size="xs"
            variant="ghost"
            disabled={storageError || busy}
            onClick={() => revise(null)}
          >
            Cancel series change
          </Button>
        </div>
      )}
      {active && relative && (
        <p className="text-fg-muted">Set fixed series dates before changing future occurrences.</p>
      )}
      {error && (
        <p className="text-error" role="alert">
          {error}
        </p>
      )}
      {accepted && (
        <div role="status" className="space-y-1">
          <p>New series saved · {accepted.name}</p>
          <p className="text-fg-muted">Starts {accepted.start}</p>
          {accepted.delivery !== 'complete' && <p>File delivery needs attention.</p>}
        </div>
      )}
    </section>
  );
}
