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

export function installChatFirstHumanInputGuard(doc: Document): () => void {
  const view = doc.defaultView;
  if (!view) return () => {};
  const block = (event: Event) => {
    if (isConversationInput(event.target) || isManualInput(event.target)) return;
    if (
      event.target instanceof Element &&
      event.target.closest('[data-ai-input-region="output"]')
    ) {
      const control = event.target.closest(
        'button,input,textarea,select,[role="button"],[role="menu"]'
      );
      if (!control && ['click', 'pointerdown', 'mousedown', 'mouseup'].includes(event.type)) return;
      if (
        event instanceof KeyboardEvent &&
        ([
          'ArrowLeft',
          'ArrowRight',
          'ArrowUp',
          'ArrowDown',
          'Home',
          'End',
          'PageUp',
          'PageDown',
        ].includes(event.key) ||
          ((event.metaKey || event.ctrlKey) && ['c', 'a'].includes(event.key.toLowerCase())))
      )
        return;
    }
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
