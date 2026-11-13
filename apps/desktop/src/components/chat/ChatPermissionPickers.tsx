import { useEffect } from 'react';
import { useShallow } from 'zustand/react/shallow';
import { useAISettingsStore } from '../../features/ai/settings';
import { useChatStore } from '../../features/ai/hooks/useChat';
import { chatPermissions } from '../../features/ai/orchestration/chat-permissions';
import { setConversationState } from '../../features/ai/orchestration/chat-runtime';
import {
  AGENT_PERMISSION_PICKERS,
  parseAgentPermissions,
  permissionFamilyForTransport,
  type AgentPermissionFamily,
} from '../../shared/agent-permissions';
import type { AssistantRouteSelection } from '../../features/ai/assistant-routes';
import { isHostedBrowserRuntime } from '../../utils/environment';
import { ChatComposerPicker } from './composer-controls';

function permissionFamily(route: AssistantRouteSelection | null): AgentPermissionFamily | null {
  if (isHostedBrowserRuntime()) return null;
  if (route?.kind === 'cli') return permissionFamilyForTransport(route.transport);
  return route?.kind === 'hosted' ? 'codex' : null;
}

export function ChatPermissionPickers({
  conversationId,
  route,
}: {
  conversationId: string | null;
  route: AssistantRouteSelection | null;
}) {
  const {
    agentPermissions: userDefaults,
    permissionCatalog: catalog,
    loadPermissionCatalog,
    setAgentPermissions: setDefaults,
  } = useAISettingsStore(
    useShallow((state) => ({
      agentPermissions: state.agentPermissions,
      permissionCatalog: state.permissionCatalog,
      loadPermissionCatalog: state.loadPermissionCatalog,
      setAgentPermissions: state.setAgentPermissions,
    }))
  );
  const conversation = useChatStore((state) =>
    conversationId ? state._convStates.get(conversationId) : undefined
  );

  useEffect(() => {
    void loadPermissionCatalog();
  }, [loadPermissionCatalog]);

  const family = permissionFamily(route);
  if (!catalog || !family) return null;
  const permissions = chatPermissions(conversation, catalog, userDefaults);

  return (
    <>
      {AGENT_PERMISSION_PICKERS[family].map((picker) => {
        const choices = catalog.options[picker.key];
        const selected = choices.find((choice) => choice.value === permissions[picker.key]);
        return (
          <ChatComposerPicker
            key={picker.key}
            value={permissions[picker.key]}
            options={choices.map((choice) => ({
              value: choice.value,
              label: choice.label,
              ...(choice.description ? { title: choice.description } : {}),
            }))}
            onChange={(next) => {
              const patch = parseAgentPermissions({ [picker.key]: next });
              if (!patch) return;
              if (conversationId && useChatStore.getState()._convStates.has(conversationId)) {
                setConversationState(useChatStore.setState, conversationId, () => ({
                  permissions: { ...permissions, ...patch },
                }));
              }
              void setDefaults(patch).catch((error: unknown) => {
                console.error('[ChatPermissionPickers] Failed to save the default:', error);
              });
            }}
            ariaLabel={picker.label}
            title={`${picker.label}: ${selected?.label ?? permissions[picker.key]}`}
            testId={picker.testId}
            className="max-w-[13rem]"
          />
        );
      })}
    </>
  );
}
