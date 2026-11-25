import { COMMAND_IDS, type CommandContext, type CommandId } from '../commands/types';
import { isLocalDevBuild, type ViteLikeEnv } from './dev-surface-gates';

export function isChatFirstInputEnabled(
  env: ViteLikeEnv & { VITE_CHAT_FIRST_INPUT?: string }
): boolean {
  return isLocalDevBuild(env) && env.VITE_CHAT_FIRST_INPUT === '1';
}

export const CHAT_FIRST_INPUT = isChatFirstInputEnabled(import.meta.env);

const navigationCommands: ReadonlySet<CommandId> = new Set([
  COMMAND_IDS.appNewChat,
  COMMAND_IDS.appFocusCommandInput,
  COMMAND_IDS.canvasNextTab,
  COMMAND_IDS.canvasPreviousTab,
  COMMAND_IDS.canvasSelectTab,
  COMMAND_IDS.chatNext,
  COMMAND_IDS.chatPrevious,
]);

export function chatFirstCommandAllowed(
  command: CommandId,
  source: CommandContext['source'],
  manualEditing = false
): boolean {
  return (
    source === 'agent' ||
    navigationCommands.has(command) ||
    (manualEditing &&
      [COMMAND_IDS.fileSave, COMMAND_IDS.editUndo, COMMAND_IDS.editRedo].some(
        (candidate) => candidate === command
      ))
  );
}

export function isConversationInput(target: EventTarget | null): boolean {
  return (
    target instanceof Element && target.closest('[data-ai-input-region="conversation"]') !== null
  );
}

export function isManualInput(target: EventTarget | null): boolean {
  return target instanceof Element && target.closest('[data-ai-input-region="manual"]') !== null;
}
