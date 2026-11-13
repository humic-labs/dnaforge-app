import { observeWorkflowAction } from '../../lib/workflow-telemetry';

export type CanvasNavigationOperation = Readonly<{ id: string; initiatedAtMs: number }>;
export type CanvasNavigationOutcome =
  | 'accepted'
  | 'noop'
  | 'refused'
  | 'superseded'
  | 'unmounted'
  | 'placed';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export type CanvasLayoutOperation = 'move' | 'reorder' | 'split' | 'merge' | 'reopen';
export type CanvasCloseOutcome =
  | 'requested'
  | 'save_requested'
  | 'discard_confirmed'
  | 'closed'
  | 'cancelled'
  | 'unmounted'
  | 'refused';
const layoutClasses = {
  move: { action: 'move', outcomeKind: 'canvas_move' },
  reorder: { action: 'move', outcomeKind: 'canvas_reorder' },
  split: { action: 'create', outcomeKind: 'canvas_split' },
  merge: { action: 'update', outcomeKind: 'canvas_merge' },
  reopen: { action: 'restore', outcomeKind: 'canvas_reopen' },
} as const;

export function newCanvasNavigationOperation(): CanvasNavigationOperation | null {
  try {
    const id = crypto.randomUUID();
    return UUID.test(id) ? { id, initiatedAtMs: Date.now() } : null;
  } catch {
    return null;
  }
}

export function observeCanvasNavigation(
  operation: CanvasNavigationOperation | null,
  outcome: CanvasNavigationOutcome,
  dependencies?: Parameters<typeof observeWorkflowAction>[1]
): boolean {
  if (!operation || !UUID.test(operation.id)) return false;
  const common = {
    workflow: 'navigation' as const,
    operationId: operation.id,
    actionId: operation.id,
    initiatedAtMs: operation.initiatedAtMs,
  };
  try {
    switch (outcome) {
      case 'accepted':
        return observeWorkflowAction(
          { ...common, action: 'select', phase: 'result', status: 'selected', resultCount: 1 },
          dependencies
        );
      case 'noop':
        return observeWorkflowAction(
          {
            ...common,
            action: 'select',
            phase: 'result',
            status: 'completed',
            resultCount: 0,
            cached: true,
          },
          dependencies
        );
      case 'placed':
        return observeWorkflowAction(
          { ...common, action: 'switch_tab', status: 'completed' },
          dependencies
        );
      case 'refused':
      case 'superseded':
      case 'unmounted':
        return observeWorkflowAction(
          {
            ...common,
            action: 'select',
            phase: 'result',
            success: false,
            status: outcome === 'refused' ? 'blocked' : 'cancelled',
            errorClass: outcome,
          },
          dependencies
        );
      default:
        return false;
    }
  } catch {
    return false;
  }
}

export function observeCanvasReadableGeneration(
  operation: CanvasNavigationOperation,
  generationId: string,
  outcome: 'readable' | 'failed',
  dependencies?: Parameters<typeof observeWorkflowAction>[1]
): boolean {
  if (!UUID.test(operation.id) || !UUID.test(generationId)) return false;
  if (outcome !== 'readable' && outcome !== 'failed') return false;
  try {
    const input: Parameters<typeof observeWorkflowAction>[0] = {
      workflow: 'content',
      action: 'view',
      phase: 'result',
      status: outcome === 'readable' ? 'viewed' : 'failed',
      success: outcome === 'readable',
      initiator: 'system',
      actionId: generationId,
      operationId: operation.id,
      initiatedAtMs: operation.initiatedAtMs,
      ...(outcome === 'failed' ? { errorClass: 'viewer_load_failed' } : {}),
    };
    return dependencies === undefined
      ? observeWorkflowAction(input)
      : observeWorkflowAction(input, dependencies);
  } catch {
    return false;
  }
}

export function observeCanvasLayout(
  operation: CanvasNavigationOperation | null,
  kind: CanvasLayoutOperation,
  outcome: 'accepted' | 'committed' | 'noop' | 'refused',
  dependencies?: Parameters<typeof observeWorkflowAction>[1]
): boolean {
  if (!operation || !UUID.test(operation.id)) return false;
  if (!Object.prototype.hasOwnProperty.call(layoutClasses, kind)) return false;
  if (!['accepted', 'committed', 'noop', 'refused'].includes(outcome)) return false;
  try {
    return observeWorkflowAction(
      {
        workflow: 'navigation',
        ...layoutClasses[kind],
        actionId: operation.id,
        operationId: operation.id,
        initiatedAtMs: operation.initiatedAtMs,
        phase: outcome === 'committed' ? 'commit' : 'result',
        status:
          outcome === 'accepted' ? 'selected' : outcome === 'refused' ? 'blocked' : 'completed',
        success: outcome !== 'refused',
        resultCount: outcome === 'committed' ? 1 : 0,
        ...(outcome === 'noop' ? { cached: true } : {}),
        ...(outcome === 'refused' ? { errorClass: 'layout_target_refused' } : {}),
      },
      dependencies
    );
  } catch {
    return false;
  }
}

export function observeCanvasClose(
  operation: CanvasNavigationOperation | null,
  outcome: CanvasCloseOutcome,
  dependencies?: Parameters<typeof observeWorkflowAction>[1]
): boolean {
  if (!operation || !UUID.test(operation.id)) return false;
  if (
    ![
      'requested',
      'save_requested',
      'discard_confirmed',
      'closed',
      'cancelled',
      'unmounted',
      'refused',
    ].includes(outcome)
  )
    return false;
  const cancelled = outcome === 'cancelled' || outcome === 'unmounted';
  const refused = outcome === 'refused';
  try {
    return observeWorkflowAction(
      {
        workflow: 'navigation',
        action: cancelled
          ? 'cancel'
          : outcome === 'save_requested' || outcome === 'discard_confirmed'
            ? 'confirm'
            : 'dismiss',
        actionId: operation.id,
        operationId: operation.id,
        initiatedAtMs: operation.initiatedAtMs,
        phase: outcome === 'closed' ? 'commit' : 'result',
        status: cancelled
          ? 'cancelled'
          : refused
            ? 'blocked'
            : outcome === 'closed'
              ? 'completed'
              : outcome === 'save_requested'
                ? 'needs_action'
                : 'selected',
        success: !cancelled && !refused,
        resultCount: outcome === 'closed' ? 1 : 0,
        outcomeKind:
          outcome === 'save_requested'
            ? 'canvas_close_save'
            : outcome === 'discard_confirmed'
              ? 'canvas_close_discard'
              : 'canvas_close',
        ...(outcome === 'unmounted' ? { errorClass: 'close_owner_unmounted' } : {}),
      },
      dependencies
    );
  } catch {
    return false;
  }
}
