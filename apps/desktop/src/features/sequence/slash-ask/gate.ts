export function isTextEntryElement(el: Element | null): boolean {
  if (!el) return false;
  const tag = el.tagName;
  if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return true;
  if ((el as HTMLElement).isContentEditable) return true;
  return false;
}

export interface SlashAskGateEnv {
  isEditMode: boolean;
  activeElement: Element | null;
  hasOpenDialog: boolean;
}

export function canOpenSlashAsk(env: SlashAskGateEnv): boolean {
  if (env.isEditMode) return false;
  if (isTextEntryElement(env.activeElement)) return false;
  if (env.hasOpenDialog) return false;
  return true;
}
