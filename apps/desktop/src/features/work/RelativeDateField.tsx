import { useEffect, useState } from 'react';
import {
  classifyLegacyWorkDate,
  type WorkResolvedDate,
  type WorkSource,
} from '@waypoint/domain-services';
import type { WorkProject } from '../../shared/work-tasks-ipc';
import { Button } from '../../shared/components/Button';
import { platform } from '../../platform';
import { DateField, fieldClass } from './DateField';
import { dateDraft, describeDate, type DateDraft } from './task-form';

interface SourceOption {
  dayField?: boolean;
  unavailable?: string;
  label: string;
  source: WorkSource;
}

function SourcePicker({
  project,
  taskId,
  subjectIds,
  choose,
}: {
  project: WorkProject;
  taskId: string;
  subjectIds: readonly string[];
  choose(option: SourceOption): void;
}) {
  const [search, setSearch] = useState('');
  const [options, setOptions] = useState<SourceOption[]>([]);
  const [status, setStatus] = useState('Loading date fields…');
  const [attempt, setAttempt] = useState(0);
  const subjectsKey = JSON.stringify(subjectIds);
  useEffect(() => {
    let current = true;
    setOptions([]);
    setStatus('Loading date fields…');
    const timer = setTimeout(
      async () => {
        const selected: string[] = JSON.parse(subjectsKey);
        const query = search.trim();
        const [records, tasks] = await Promise.allSettled([
          Promise.resolve().then(() =>
            platform().lims.queryRegistrySummaries({
              workspaceIds: [project.workspaceId],
              ...(query ? { search: query } : selected.length ? { ids: selected } : {}),
              limit: 25,
            })
          ),
          Promise.resolve().then(() =>
            platform().workTasks.query({
              workspaceRoot: project.root,
              state: 'all',
              search: query || undefined,
              limit: 25,
            })
          ),
        ]);
        if (!current) return;
        const choices: SourceOption[] = [];
        if (records.status === 'fulfilled') {
          for (const record of records.value.summaries) {
            if (record.archived) continue;
            for (const field of record.schemaSnapshot.fields) {
              if (field.type !== 'date') continue;
              const parsed = classifyLegacyWorkDate(record.fieldValues[field.key], 'UTC');
              choices.push({
                ...(parsed.kind === 'exact'
                  ? {}
                  : {
                      unavailable:
                        parsed.kind === 'missing' ? 'Empty field' : 'Needs an exact date',
                    }),
                dayField: parsed.kind === 'exact' && parsed.value.kind === 'day',
                label: record.name + ' · ' + field.label,
                source: { projectId: project.id, resourceId: record.id, role: field.key },
              });
            }
          }
        }
        if (tasks.status === 'fulfilled') {
          for (const task of tasks.value.tasks) {
            if (task.project.id !== project.id || task.id === taskId) continue;
            if (task.document.plan)
              choices.push({
                label: task.document.name + ' · Plan for',
                unavailable:
                  task.schedule.start.kind === 'resolved' ? undefined : 'Date unavailable',
                source: { projectId: project.id, resourceId: task.id, role: 'plan-start' },
              });
            if (task.document.plan?.end)
              choices.push({
                label: task.document.name + ' · Planned end',
                unavailable: task.schedule.end.kind === 'resolved' ? undefined : 'Date unavailable',
                source: { projectId: project.id, resourceId: task.id, role: 'plan-end' },
              });
            if (task.document.deadline)
              choices.push({
                label: task.document.name + ' · Due',
                unavailable:
                  task.schedule.deadline.kind === 'resolved' ? undefined : 'Date unavailable',
                source: { projectId: project.id, resourceId: task.id, role: 'deadline' },
              });
          }
        }
        setOptions(choices);
        const failed =
          records.status === 'rejected' ||
          tasks.status === 'rejected' ||
          tasks.value.unavailable.length > 0;
        setStatus(
          failed
            ? 'Some source records could not be loaded.'
            : choices.length
              ? ''
              : 'No matching date fields. Search by record or task name.'
        );
      },
      search ? 200 : 0
    );
    return () => {
      current = false;
      clearTimeout(timer);
    };
  }, [project.id, project.root, project.workspaceId, subjectsKey, search, attempt, taskId]);
  return (
    <div className="space-y-1 rounded border border-border bg-bg-subtle p-2">
      <input
        type="search"
        aria-label="Find date source"
        placeholder="Find a record or task"
        className={fieldClass}
        value={search}
        onChange={(e) => setSearch(e.target.value)}
      />
      <div className="max-h-36 overflow-y-auto">
        {options.map((option) => (
          <button
            type="button"
            key={JSON.stringify(option.source)}
            disabled={!!option.unavailable}
            onClick={() => choose(option)}
            className="block w-full rounded px-1 py-1 text-left text-xs hover:bg-bg-muted disabled:text-fg-muted"
          >
            {option.label}
            {option.unavailable && ' · ' + option.unavailable}
          </button>
        ))}
      </div>
      {status && (
        <p role="status" className="text-xs text-fg-muted">
          {status}
        </p>
      )}
      {status.includes('could not') && (
        <Button type="button" size="xs" variant="ghost" onClick={() => setAttempt((n) => n + 1)}>
          Retry sources
        </Button>
      )}
    </div>
  );
}

export function RelativeDateField({
  label,
  resolution,
  value,
  change,
  project,
  taskId,
  subjectIds,
}: {
  label: string;
  resolution?: WorkResolvedDate;
  value: DateDraft;
  change(value: DateDraft): void;
  project: WorkProject;
  taskId: string;
  subjectIds: readonly string[];
}) {
  const [choosing, setChoosing] = useState(false);
  const [picked, setPicked] = useState<SourceOption | null>(null);
  const spec = value.relative;
  const [zeroDirection, setZeroDirection] = useState(1);
  const [elapsedUnit, setElapsedUnit] = useState<'hours' | 'minutes' | 'milliseconds'>('hours');
  const direction = spec?.offset.amount ? Math.sign(spec.offset.amount) : zeroDirection;
  const elapsedFactors = { hours: 3_600_000, minutes: 60_000, milliseconds: 1 };
  const unit = spec?.offset.unit === 'days' ? 'days' : elapsedUnit;
  const factor = unit === 'days' ? 1 : elapsedFactors[unit];
  function setOffset(amount: number, chosen = unit) {
    if (!spec) return;
    const raw = chosen === 'days' ? amount : amount * elapsedFactors[chosen];
    if (!Number.isSafeInteger(raw)) return;
    change({
      ...value,
      relative: {
        ...spec,
        offset: { unit: chosen === 'days' ? 'days' : 'milliseconds', amount: raw },
      },
    });
  }
  const select = (option: SourceOption) => {
    setPicked(option);
    setChoosing(false);
    change({
      ...dateDraft(),
      relative: {
        kind: 'relative',
        source: option.dayField ? { ...option.source, zone: value.zone } : option.source,
        offset: spec?.offset ?? { unit: 'days', amount: 0 },
      },
    });
  };
  return (
    <div className="min-w-0 space-y-1">
      {spec ? (
        <div className="space-y-1">
          <p className="text-xs font-medium">{label}</p>
          <p className="break-words text-xs">
            {picked &&
            picked.source.projectId === spec.source.projectId &&
            picked.source.resourceId === spec.source.resourceId &&
            picked.source.role === spec.source.role
              ? picked.label
              : spec.source.role + ' · ' + spec.source.resourceId}
          </p>
          {spec.source.zone !== undefined && (
            <label className="block text-xs">
              Source date time zone
              <input
                className={fieldClass}
                aria-label={label + ' source time zone'}
                value={spec.source.zone}
                onChange={(e) =>
                  change({
                    ...value,
                    relative: { ...spec, source: { ...spec.source, zone: e.target.value } },
                  })
                }
              />
            </label>
          )}
          {resolution && (
            <p className="text-xs text-fg-muted">
              {resolution.kind === 'resolved'
                ? describeDate(resolution.value)
                : resolution.kind === 'unresolved'
                  ? 'Unresolved · ' + resolution.reason
                  : 'Source date missing'}
            </p>
          )}
          {spec.source.revisionId && (
            <p className="break-all text-xs text-fg-muted">
              Pinned revision {spec.source.revisionId}
            </p>
          )}
          <label className="block text-xs">
            Offset
            <input
              type="number"
              min="0"
              step={unit === 'days' ? '1' : 'any'}
              aria-label={label + ' offset'}
              className={fieldClass}
              value={Math.abs(spec.offset.amount) / factor}
              onChange={(e) => setOffset(Math.abs(e.target.valueAsNumber) * direction)}
            />
          </label>
          <select
            className={fieldClass}
            aria-label={label + ' offset unit'}
            value={unit}
            onChange={(e) => {
              const next = e.target.value as typeof unit;
              if (next !== 'days') setElapsedUnit(next);
              setOffset(spec.offset.amount / factor, next);
            }}
          >
            <option value="days">Calendar days</option>
            <option value="hours">Hours</option>
            <option value="minutes">Minutes</option>
            <option value="milliseconds">Milliseconds</option>
          </select>
          <select
            className={fieldClass}
            aria-label={label + ' offset direction'}
            value={direction}
            onChange={(e) => {
              const next = Number(e.target.value);
              setZeroDirection(next);
              setOffset((Math.abs(spec.offset.amount) / factor) * next);
            }}
          >
            <option value="-1">Before source date</option>
            <option value="1">After source date</option>
          </select>
          <Button
            type="button"
            size="xs"
            variant="ghost"
            onClick={() => {
              change(dateDraft());
              setChoosing(false);
            }}
          >
            Use fixed date
          </Button>
        </div>
      ) : (
        <DateField label={label} value={value} change={change} />
      )}
      <Button
        type="button"
        size="xs"
        variant="ghost"
        aria-label={label + ' date source'}
        onClick={() => setChoosing(!choosing)}
      >
        {choosing ? 'Close source search' : spec ? 'Change source' : 'Follow a date'}
      </Button>
      {choosing && (
        <SourcePicker project={project} taskId={taskId} subjectIds={subjectIds} choose={select} />
      )}
    </div>
  );
}
