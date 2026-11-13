import { lazy, Suspense } from 'react';
import { COMMAND_IDS } from '../../../commands';
import { SparklesIcon } from '../../../components/icons/glyphs';
import type { RendererFeature } from '../../../feature-registry/renderer-feature';
import { AgentWaitingBadge } from '../agent-confirm/AgentWaitingBadge';

const AIConversationsSidebar = lazy(() =>
  import('../components/AIConversationsSidebar').then((module) => ({
    default: module.AIConversationsSidebar,
  }))
);

function AIConversationsView() {
  return (
    <Suspense fallback={null}>
      <AIConversationsSidebar />
    </Suspense>
  );
}

export const aiRendererFeature: RendererFeature = {
  id: 'ai',
  views: [
    {
      view: 'ai',
      placement: 'sidebar',
      Component: AIConversationsView,
      screenCategory: 'unknown',
      activityButton: {
        label: 'AI Tools',
        icon: <SparklesIcon />,
        badge: <AgentWaitingBadge />,
        testId: 'ai-tools-button',
        command: COMMAND_IDS.appFocusCommandInput,
      },
    },
  ],
};
