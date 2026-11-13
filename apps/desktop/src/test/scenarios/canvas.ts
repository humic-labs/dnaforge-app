import type { TabType } from '../../features/canvas/types';
import type { AppScenario } from './types';

export function withSequenceTab(
  scenario: AppScenario,
  input: { documentId: string; sourcePath: string; label: string }
): AppScenario {
  return {
    ...scenario,
    sequenceSources: {
      ...scenario.sequenceSources,
      [input.documentId]: { sourcePath: input.sourcePath, name: input.label },
    },
    canvas: {
      ...scenario.canvas,
      tabs: [
        ...(scenario.canvas?.tabs ?? []),
        {
          type: 'sequence',
          entityId: input.documentId,
          label: input.label,
          sequenceDocument: { kind: 'catalog-sequence', entityId: input.documentId },
        },
      ],
    },
  };
}

export function withChatTab(
  scenario: AppScenario,
  conversationId = 'test-conversation'
): AppScenario {
  return {
    ...scenario,
    canvas: {
      ...scenario.canvas,
      tabs: [
        ...(scenario.canvas?.tabs ?? []),
        { type: 'chat', entityId: conversationId, label: 'Chat' },
      ],
    },
  };
}

export function withSplitLayout(
  scenario: AppScenario,
  direction: 'split-horizontal' | 'split-vertical' = 'split-vertical'
): AppScenario {
  return {
    ...scenario,
    canvas: {
      ...scenario.canvas,
      tabs: scenario.canvas?.tabs ?? [],
      layout: direction,
    },
  };
}

export function withMultiLane(
  scenario: AppScenario,
  config: NonNullable<AppScenario['multiLane']>
): AppScenario {
  return { ...scenario, multiLane: config };
}

export function withMultipleTabs(
  scenario: AppScenario,
  tabs: Array<
    | { type: 'sequence'; documentId: string; label: string }
    | { type: Exclude<TabType, 'sequence'>; entityId: string; label?: string }
  >
): AppScenario {
  return {
    ...scenario,
    canvas: {
      ...scenario.canvas,
      tabs: [
        ...(scenario.canvas?.tabs ?? []),
        ...tabs.map((t) => ({
          type: t.type,
          entityId: t.type === 'sequence' ? t.documentId : t.entityId,
          label:
            t.label ??
            (t.type === 'sequence' ? t.documentId : t.entityId).split('/').pop() ??
            'Document',
          ...(t.type === 'sequence'
            ? {
                sequenceDocument: {
                  kind: 'catalog-sequence' as const,
                  entityId: t.documentId,
                },
              }
            : {}),
        })),
      ],
    },
  };
}
