import { z } from 'zod';
import {
  workTimeFromInput,
  type WorkDateSpec,
  type WorkTaskCommand,
} from '@waypoint/domain-services';
import { platform } from '../../../platform';
import type { WorkspaceFolder } from '../../../stores/workspaceStore';
import type { WorkTaskRecord } from '../../../shared/work-tasks-ipc';
import { resolveExplicitProjectRoot } from '../../../shared/project-root-selection';
import { workReminderCommandSchema } from '../../../shared/work-reminders-ipc';
import { resultTool, toolFailure, toolSuccess } from '../../agent-bridge/public/tool-result';

const identity = z.string().min(1).max(200);
const link = z
  .object({
    projectId: identity,
    resourceId: identity,
    role: identity.optional(),
    revisionId: identity.optional(),
  })
  .strict();
const assignee = z.object({ kind: z.enum(['local', 'member']), id: identity }).strict();
const day = z.object({ kind: z.literal('day'), date: z.string(), zone: z.string() }).strict();
const timed = z
  .object({
    kind: z.literal('timed'),
    local: z.string(),
    zone: z.string(),
    fold: z.enum(['earlier', 'later']).optional(),
  })
  .strict();
const timeInput = z.union([day, timed]);
const savedTime = z.union([
  day,
  z
    .object({ kind: z.literal('timed'), local: z.string(), zone: z.string(), instant: z.number() })
    .strict(),
]);
const relative = z
  .object({
    kind: z.literal('relative'),
    source: link.extend({ role: identity, zone: z.string().optional() }).strict(),
    offset: z.object({ unit: z.enum(['days', 'milliseconds']), amount: z.number().int() }).strict(),
  })
  .strict();
const dateInput = z.union([
  z.object({ kind: z.literal('fixed'), value: timeInput }).strict(),
  relative,
]);
const dateValue = z.union([
  z.object({ kind: z.literal('fixed'), value: savedTime }).strict(),
  relative,
]);
const planInput = z.object({ start: dateInput, end: dateInput.optional() }).strict();
const recurrenceFields = {
  frequency: z.enum(['daily', 'weekly', 'monthly']),
  interval: z.number().int().min(1).max(1000),
  weekdays: z.array(z.number().int().min(1).max(7)).max(7).optional(),
  count: z.number().int().min(1).max(100000).optional(),
  until: z.string().optional(),
  fold: z.enum(['earlier', 'later']),
  state: z.enum(['active', 'paused', 'ended']),
};
const recurrenceInput = z.object({ ...recurrenceFields, anchor: timeInput }).strict();
const recurrenceValue = z
  .object({
    ...recurrenceFields,
    anchor: savedTime,
    excludedSlots: z.array(z.string()).optional(),
    pauses: z
      .array(z.object({ start: z.number(), end: z.number().nullable() }).strict())
      .optional(),
  })
  .strict();
const fields = {
  name: z.string().trim().min(1).max(500).optional(),
  description: z.string().max(20000).optional(),
  assignee: assignee.nullable().optional(),
  links: z.array(link).max(100).optional(),
  plan: planInput.nullable().optional(),
  deadline: dateInput.nullable().optional(),
  recurrence: recurrenceInput.nullable().optional(),
};
const target = { taskId: identity };
const write = { ...target, operationId: identity, expectedRevisionId: identity };
const completion = {
  actualAt: z.number().int().optional(),
  evidence: z.array(link).max(100).optional(),
};

export const workTasksSchema = z
  .object({
    project: z.string().min(1),
    operation: z.discriminatedUnion('kind', [
      z
        .object({
          kind: z.literal('query'),
          state: z.enum(['active', 'all', 'done']).optional(),
          assignee: z.enum(['me', 'unassigned', 'all']).optional(),
          subjectId: identity.optional(),
          search: z.string().max(500).optional(),
          offset: z.number().int().nonnegative().optional(),
          limit: z.number().int().min(1).max(500).optional(),
        })
        .strict(),
      z.object({ kind: z.literal('inspect'), ...target }).strict(),
      z.object({ kind: z.literal('history'), ...target }).strict(),
      z
        .object({
          kind: z.literal('dates'),
          offset: z.number().int().nonnegative().optional(),
          limit: z.number().int().min(1).max(500).optional(),
        })
        .strict(),
      z.object({ kind: z.literal('reminders') }).strict(),
      z
        .object({
          kind: z.literal('reminder-command'),
          requestId: z.string().uuid(),
          command: workReminderCommandSchema,
        })
        .strict(),
      z
        .object({
          kind: z.literal('occurrences'),
          ...target,
          from: z.string(),
          through: z.string(),
        })
        .strict(),
      z
        .object({
          kind: z.literal('create'),
          ...target,
          operationId: identity,
          ...fields,
          name: z.string().trim().min(1).max(500),
        })
        .strict(),
      z.object({ kind: z.literal('edit'), ...write, ...fields }).strict(),
      z
        .object({
          kind: z.literal('split'),
          ...write,
          successorId: identity,
          firstSlot: z.string(),
          replacement: recurrenceInput,
        })
        .strict(),
      z.object({ kind: z.literal('start'), ...write }).strict(),
      z.object({ kind: z.literal('todo'), ...write }).strict(),
      z.object({ kind: z.literal('complete'), ...write, ...completion }).strict(),
      z
        .object({ kind: z.literal('cancel'), ...write, reason: z.string().max(2000).optional() })
        .strict(),
      z.object({ kind: z.literal('reopen'), ...write }).strict(),
      z
        .object({
          kind: z.literal('occurrence'),
          ...write,
          slot: z.string(),
          action: z.discriminatedUnion('kind', [
            z
              .object({
                kind: z.literal('move'),
                plan: planInput.nullable(),
                deadline: dateInput.nullable(),
              })
              .strict(),
            z.object({ kind: z.literal('skip') }).strict(),
            z.object({ kind: z.literal('restore') }).strict(),
            z.object({ kind: z.literal('start') }).strict(),
            z.object({ kind: z.literal('todo') }).strict(),
            z.object({ kind: z.literal('reopen') }).strict(),
            z.object({ kind: z.literal('complete'), ...completion }).strict(),
            z
              .object({ kind: z.literal('cancel'), reason: z.string().max(2000).optional() })
              .strict(),
          ]),
        })
        .strict(),
    ]),
  })
  .strict();

const resolution = z.union([
  z.object({ kind: z.literal('missing') }).strict(),
  z.object({ kind: z.literal('unresolved'), reason: z.string() }).strict(),
  z
    .object({
      kind: z.literal('resolved'),
      value: savedTime,
      sources: z.array(link.extend({ role: identity, zone: z.string().optional() }).strict()),
    })
    .strict(),
]);
const schedule = z.object({ start: resolution, end: resolution, deadline: resolution }).strict();
const completionResult = z
  .object({
    actualAt: z.number(),
    recordedAt: z.number(),
    reported: z.boolean(),
    actor: z.string(),
    assignee: assignee.nullable(),
    evidence: z.array(link),
    schedule,
  })
  .strict();
const cancellationResult = z
  .object({ recordedAt: z.number(), actor: z.string(), reason: z.string().nullable(), schedule })
  .strict();
const occurrenceResult = z
  .object({
    slot: z.string(),
    nominal: savedTime,
    status: z.enum(['todo', 'in-progress', 'done', 'canceled', 'skipped']),
    schedule,
    assignee: assignee.nullable(),
    recurrence: recurrenceValue,
    completion: completionResult.nullable(),
    cancellation: cancellationResult.nullable(),
    override: z
      .object({
        plan: z.object({ start: dateValue, end: dateValue.optional() }).strict().nullable(),
        deadline: dateValue.nullable(),
      })
      .strict()
      .optional(),
  })
  .strict();
const taskResult = z
  .object({
    id: identity,
    revisionId: identity,
    project: z.object({ id: identity, name: z.string() }).strict(),
    name: z.string(),
    description: z.string(),
    status: z.enum(['todo', 'in-progress', 'done', 'canceled']),
    assignee: assignee.nullable(),
    links: z.array(link),
    plan: z.object({ start: dateValue, end: dateValue.optional() }).strict().nullable(),
    deadline: dateValue.nullable(),
    recurrence: recurrenceValue.nullable(),
    schedule,
    due: z.enum(['terminal', 'unscheduled', 'unresolved', 'upcoming', 'today', 'overdue']),
    completion: completionResult.nullable(),
    cancellation: cancellationResult.nullable(),
  })
  .strict();
export const workTasksOutputSchema = z.discriminatedUnion('kind', [
  z
    .object({
      ok: z.literal(true),
      kind: z.literal('split'),
      task: taskResult.nullable(),
      successor: taskResult.nullable(),
      operationId: identity,
      replayed: z.boolean(),
      outcome: z.enum(['changed', 'no-op']),
      fileDelivery: z.enum(['complete', 'pending']),
    })
    .strict(),
  z
    .object({
      ok: z.literal(true),
      kind: z.literal('dates'),
      total: z.number(),
      nextOffset: z.number().nullable(),
      rows: z.array(
        z
          .object({
            id: identity,
            project: z.object({ id: identity, name: z.string() }).strict(),
            entityId: identity,
            entityName: z.string(),
            fieldKey: identity,
            label: z.string(),
            role: z.enum(['milestone', 'deadline', 'observation']),
            revisionId: identity.nullable(),
            schemaRevisionId: identity,
            status: z.enum(['resolved', 'unresolved']),
            value: savedTime.nullable(),
            raw: z.string().nullable().optional(),
          })
          .strict()
      ),
    })
    .strict(),
  z
    .object({
      ok: z.literal(true),
      kind: z.literal('reminders'),
      view: z
        .object({
          authority: z.enum(['local', 'fenced', 'hosted', 'unarmed', 'suspended']),
          scope: z.enum(['local', 'shared']),
          available: z.boolean(),
          epoch: z.number(),
          canOfferHandoff: z.boolean().optional(),
          canAcceptHandoff: z.boolean().optional(),
          pendingHandoff: z
            .object({ requestId: identity, expectedEpoch: z.number() })
            .strict()
            .optional(),
          offers: z.array(z.object({ id: identity, epoch: z.number() }).strict()).optional(),
          consent: z
            .object({
              inbox_enabled: z.boolean(),
              desktop_enabled: z.boolean().optional(),
              email_enabled: z.boolean(),
              revision: z.number(),
            })
            .nullable(),
          rules: z.array(
            z.object({
              id: identity,
              task_id: identity,
              role: z.enum(['start', 'deadline']),
              offset_ms: z.number(),
              day_time: z.string().nullable(),
              day_fold: z.enum(['earlier', 'later']),
              generation: z.number(),
              state: z.enum(['armed', 'retired']),
              email_enabled: z.boolean(),
              desktop_enabled: z.boolean().optional(),
            })
          ),
          inbox: z.array(
            z.object({
              id: identity,
              effect_key: z.string(),
              task_id: identity,
              state: z.enum(['unread', 'read', 'snoozed', 'dismissed']),
              revision: z.number(),
              wake_at: z.string().nullable(),
              created_at: z.string(),
              sourceCurrent: z.boolean(),
            })
          ),
          deliveries: z.array(
            z.object({
              effectKey: z.string(),
              state: z.string(),
              suppressionReason: z.string().nullable(),
              providerId: z.string().nullable(),
              admittedAt: z.string().nullable(),
            })
          ),
          subscriptions: z.array(
            z.object({
              id: identity,
              generation: z.number(),
              roles: z.array(z.enum(['plan', 'deadline'])),
              state: z.enum(['active', 'revoked']),
              expires_at: z.string(),
            })
          ),
        })
        .strict(),
    })
    .strict(),
  z
    .object({
      ok: z.literal(true),
      kind: z.literal('reminder-command'),
      result: z
        .object({
          outcome: z.literal('applied'),
          id: identity.optional(),
          url: z.string().optional(),
          secretUnavailable: z.boolean().optional(),
          bearerNotice: z.string().optional(),
          state: z.string().optional(),
          revision: z.number().optional(),
          epoch: z.number().optional(),
        })
        .strict(),
    })
    .strict(),
  z
    .object({
      ok: z.literal(true),
      kind: z.literal('occurrences'),
      occurrences: z.array(occurrenceResult),
    })
    .strict(),
  z
    .object({
      ok: z.literal(true),
      kind: z.literal('query'),
      tasks: z.array(taskResult),
      total: z.number(),
      nextOffset: z.number().nullable(),
      unavailableProjects: z.number(),
    })
    .strict(),
  z
    .object({ ok: z.literal(true), kind: z.literal('inspect'), task: taskResult.nullable() })
    .strict(),
  z
    .object({
      ok: z.literal(true),
      kind: z.literal('history'),
      revisions: z.array(
        z
          .object({
            revisionId: identity,
            status: z.string(),
            name: z.string(),
            recordedAt: z.number(),
            actor: z.string(),
            plan: z.object({ start: dateValue, end: dateValue.optional() }).strict().nullable(),
            deadline: dateValue.nullable(),
            completion: completionResult.nullable(),
            cancellation: cancellationResult.nullable(),
            occurrences: z.array(occurrenceResult),
          })
          .strict()
      ),
    })
    .strict(),
  z
    .object({
      ok: z.literal(true),
      kind: z.literal('mutate'),
      task: taskResult.nullable(),
      operationId: identity,
      replayed: z.boolean(),
      outcome: z.enum(['changed', 'no-op']),
      fileDelivery: z.enum(['complete', 'pending']),
    })
    .strict(),
]);

function publicTask(record: WorkTaskRecord) {
  const task = record.document;
  return {
    id: record.id,
    revisionId: record.revisionId,
    project: { id: record.project.id, name: record.project.name },
    name: task.name,
    description: task.description,
    status: task.status,
    assignee: task.assignee,
    links: task.links,
    plan: task.plan,
    deadline: task.deadline,
    recurrence: task.recurrence,
    schedule: record.schedule,
    due: record.due,
    completion: task.completion,
    cancellation: task.cancellation,
  };
}

function canonicalDate(value: z.infer<typeof dateInput>): WorkDateSpec {
  return value.kind === 'fixed' ? { kind: 'fixed', value: workTimeFromInput(value.value) } : value;
}

export const WORK_TASKS_DESCRIPTION =
  'Create, inspect, schedule, assign, complete and reopen project tasks. Query and inspect first. Retain taskId, operationId, expectedRevisionId and unchanged inputs when retrying an uncertain mutation. Plan and deadline are independent. Dates retain their named zone; repeated local hours require an earlier/later choice. Completion/cancellation freeze their schedules and history. Follow declared scientific field roles or task plan-start/plan-end/deadline with explicit offsets. Read bounded occurrences and act on their original slot. Split future repetitions atomically using a retained successorId, keeping the original clock and zone. Inspect opted-in record dates and personal reminder/inbox/calendar settings. Reminder commands retain requestId on retry; channel consent is explicit. Scientific source dates keep their native owners.';

export function createWorkTasksTool(folders: readonly WorkspaceFolder[]) {
  return resultTool({
    description: WORK_TASKS_DESCRIPTION,
    inputSchema: workTasksSchema,
    execute: async ({ project, operation }) => {
      let attempted = false;
      try {
        const destination = resolveExplicitProjectRoot(folders, project);
        if (!destination) throw new Error('Choose an exact mounted project.');
        const workspaceRoot = destination.path;
        const service = platform().workTasks;
        if (operation.kind === 'dates') {
          const result = await service.dates({
            workspaceRoot,
            offset: operation.offset,
            limit: operation.limit,
          });
          return toolSuccess({
            ...result,
            kind: 'dates' as const,
            rows: result.rows.map((row) => ({
              ...row,
              project: { id: row.project.id, name: row.project.name },
            })),
          });
        }
        if (operation.kind === 'reminders')
          return toolSuccess({
            kind: 'reminders' as const,
            view: await service.reminders({ workspaceRoot }),
          });
        if (operation.kind === 'reminder-command') {
          attempted = true;
          const result = await service.reminderCommand({
            workspaceRoot,
            requestId: operation.requestId,
            command: operation.command,
          });
          if (result.outcome === 'rejected') {
            const confirmed = result.confirmedRequestId === operation.requestId;
            return toolFailure({
              code: confirmed ? 'WORK_REMINDER_REJECTED' : 'WORK_REMINDER_OUTCOME_UNAVAILABLE',
              error: result.error,
              retriable: !confirmed,
              stateChanged: confirmed ? false : 'unknown',
              partialEffects: [],
            });
          }
          return toolSuccess({ kind: 'reminder-command' as const, result });
        }
        if (operation.kind === 'query') {
          const { kind: _kind, ...query } = operation;
          const result = await service.query({ workspaceRoot, ...query });
          return toolSuccess({
            kind: 'query' as const,
            tasks: result.tasks.map(publicTask),
            total: result.total,
            nextOffset: result.nextOffset,
            unavailableProjects: result.unavailable.length,
          });
        }
        if (operation.kind === 'inspect') {
          const task = await service.read({ workspaceRoot, taskId: operation.taskId });
          return toolSuccess({ kind: 'inspect' as const, task: task ? publicTask(task) : null });
        }
        if (operation.kind === 'history') {
          const result = await service.history({ workspaceRoot, taskId: operation.taskId });
          return toolSuccess({
            kind: 'history' as const,
            revisions: result.revisions.map(({ revisionId, document }) => ({
              revisionId,
              status: document.status,
              name: document.name,
              recordedAt: document.updatedAt,
              actor: document.updatedBy,
              plan: document.plan,
              deadline: document.deadline,
              completion: document.completion,
              cancellation: document.cancellation,
              occurrences: document.occurrences,
            })),
          });
        }
        if (operation.kind === 'occurrences') {
          const rows = await service.occurrences({
            workspaceRoot,
            taskId: operation.taskId,
            from: operation.from,
            through: operation.through,
          });
          return toolSuccess({
            kind: 'occurrences' as const,
            occurrences: rows,
          });
        }
        if (destination.pinned) throw new Error('This project is read only.');
        if (operation.kind === 'split') {
          const { kind: _kind, replacement, ...split } = operation;
          const rule = { ...replacement, anchor: workTimeFromInput(replacement.anchor) };
          attempted = true;
          const result = await service.split({ workspaceRoot, ...split, replacement: rule });
          const receipt = result.submission.receipt;
          if (receipt.outcome !== 'changed' && receipt.outcome !== 'no-op')
            return toolFailure({
              code: receipt.outcome === 'conflict' ? 'WORK_TASK_CONFLICT' : 'WORK_TASK_REJECTED',
              error: 'Inspect the current series and reconcile the proposed change.',
              retriable: false,
              stateChanged: false,
              partialEffects: [],
            });
          return toolSuccess({
            kind: 'split' as const,
            task: result.task ? publicTask(result.task) : null,
            successor: result.successor ? publicTask(result.successor) : null,
            operationId: operation.operationId,
            replayed: result.submission.replayed,
            outcome: receipt.outcome,
            fileDelivery:
              result.submission.delivery?.kind === 'complete'
                ? ('complete' as const)
                : ('pending' as const),
          });
        }
        const { taskId, operationId, ...input } = operation;
        const expectedRevisionId = 'expectedRevisionId' in input ? input.expectedRevisionId : null;
        let command: WorkTaskCommand;
        if (input.kind === 'create' || input.kind === 'edit') {
          const plan =
            input.plan === undefined
              ? undefined
              : input.plan === null
                ? null
                : {
                    start: canonicalDate(input.plan.start),
                    ...(input.plan.end ? { end: canonicalDate(input.plan.end) } : {}),
                  };
          const deadline =
            input.deadline === undefined
              ? undefined
              : input.deadline === null
                ? null
                : canonicalDate(input.deadline);
          command = {
            kind: input.kind,
            ...(input.name === undefined ? {} : { name: input.name }),
            ...(input.description === undefined ? {} : { description: input.description }),
            ...(input.assignee === undefined ? {} : { assignee: input.assignee }),
            ...(input.links === undefined ? {} : { links: input.links }),
            ...(plan === undefined ? {} : { plan }),
            ...(deadline === undefined ? {} : { deadline }),
            ...(input.recurrence === undefined
              ? {}
              : {
                  recurrence:
                    input.recurrence === null
                      ? null
                      : { ...input.recurrence, anchor: workTimeFromInput(input.recurrence.anchor) },
                }),
          } as WorkTaskCommand;
        } else if (input.kind === 'occurrence') {
          command = {
            kind: 'occurrence',
            slot: input.slot,
            action:
              input.action.kind !== 'move'
                ? input.action
                : {
                    kind: 'move',
                    plan:
                      input.action.plan === null
                        ? null
                        : {
                            start: canonicalDate(input.action.plan.start),
                            ...(input.action.plan.end
                              ? { end: canonicalDate(input.action.plan.end) }
                              : {}),
                          },
                    deadline:
                      input.action.deadline === null ? null : canonicalDate(input.action.deadline),
                  },
          };
        } else {
          const { expectedRevisionId: _revision, ...stateCommand } = input;
          command = stateCommand;
        }
        attempted = true;
        const result = await service.mutate({
          workspaceRoot,
          taskId,
          operationId,
          expectedRevisionId,
          command,
        });
        const receipt = result.submission.receipt;
        if (receipt.outcome !== 'changed' && receipt.outcome !== 'no-op') {
          return toolFailure({
            code: receipt.outcome === 'conflict' ? 'WORK_TASK_CONFLICT' : 'WORK_TASK_REJECTED',
            error:
              'Inspect the current task and reconcile the proposed change before submitting a new operation.',
            retriable: false,
            stateChanged: false,
            partialEffects: [],
          });
        }
        return toolSuccess({
          kind: 'mutate' as const,
          task: result.task ? publicTask(result.task) : null,
          operationId,
          replayed: result.submission.replayed,
          outcome: receipt.outcome,
          fileDelivery:
            result.submission.delivery?.kind === 'complete'
              ? ('complete' as const)
              : ('pending' as const),
        });
      } catch (error) {
        return toolFailure({
          code: 'WORK_TASK_FAILED',
          error: error instanceof Error ? error.message : String(error),
          retriable: attempted,
          stateChanged: attempted ? 'unknown' : false,
          partialEffects: [],
        });
      }
    },
  });
}
