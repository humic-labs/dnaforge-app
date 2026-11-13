import { toUserMessage } from '@waypoint/user-messages';
import { useToastStore } from '../../../stores/toast-store';
import {
  describeAssistantRouteFallback,
  type AssistantSendRouteResolution,
} from '../assistant-send-route';

export function announceAssistantRouteFallback(resolution: AssistantSendRouteResolution): void {
  if (resolution.status !== 'fallback') return;
  useToastStore.getState().addToast(toUserMessage(describeAssistantRouteFallback(resolution)), {
    definition: 'assistant-route-fallback',
  });
}
