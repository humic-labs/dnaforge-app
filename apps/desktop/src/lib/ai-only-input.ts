import { COMMAND_IDS, type CommandContext, type CommandId } from '../commands/types';
import { isLocalDevBuild, type ViteLikeEnv } from './dev-surface-gates';

export function isAiOnlyInputEnabled(env: ViteLikeEnv & { VITE_AI_ONLY_INPUT?: string }): boolean {
  return isLocalDevBuild(env) && env.VITE_AI_ONLY_INPUT === '1';
}

export const AI_ONLY_INPUT = isAiOnlyInputEnabled(import.meta.env);

const navigationCommands: ReadonlySet<CommandId> = new Set([
  COMMAND_IDS.appNewChat,
  COMMAND_IDS.appFocusCommandInput,
  COMMAND_IDS.canvasNextTab,
  COMMAND_IDS.canvasPreviousTab,
  COMMAND_IDS.canvasSelectTab,
  COMMAND_IDS.chatNext,
  COMMAND_IDS.chatPrevious,
]);

export function aiOnlyCommandAllowed(
  command: CommandId,
  source: CommandContext['source']
): boolean {
  return source === 'agent' || navigationCommands.has(command);
}

export function isConversationInput(target: EventTarget | null): boolean {
  return (
    target instanceof Element && target.closest('[data-ai-input-region="conversation"]') !== null
  );
}

export function installAiOnlyHumanInputGuard(doc: Document): () => void {
  const view = doc.defaultView;
  if (!view) return () => {};
  const block = (event: Event) => {
    if (isConversationInput(event.target)) return;
    if (
      event.target instanceof Element &&
      event.target.closest('[data-ai-input-region="navigation"]')
    ) {
      if (['click', 'pointerdown', 'mousedown', 'mouseup'].includes(event.type)) return;
      if (event instanceof KeyboardEvent && ['Tab', 'Enter', ' '].includes(event.key)) return;
    }
    if (event.type === 'keydown' && event instanceof KeyboardEvent && event.key === 'Tab') return;
    event.preventDefault();
    event.stopImmediatePropagation();
  };
  const events = [
    'click',
    'pointerdown',
    'mousedown',
    'mouseup',
    'beforeinput',
    'paste',
    'cut',
    'drop',
    'dragstart',
    'contextmenu',
    'dblclick',
    'keydown',
  ];
  for (const type of events) view.addEventListener(type, block, true);
  return () => {
    for (const type of events) view.removeEventListener(type, block, true);
  };
}
