const BUTTON_BASE = 'w-6 h-6 flex items-center justify-center rounded text-xs transition-colors';
const BUTTON_DISABLED = 'opacity-40 cursor-not-allowed text-fg-muted';
const BUTTON_IDLE = 'text-fg-muted hover:bg-bg-muted hover:text-fg';

export function tableGridFormatControlsDisabled(
  effectiveSelection: unknown,
  onCellFormat: unknown
): boolean {
  return !effectiveSelection || !onCellFormat;
}

export function tableGridFormatToggleClass(
  disabled: boolean,
  state: boolean | 'mixed',
  extraBase = ''
): string {
  const base = `${BUTTON_BASE}${extraBase}`;
  if (disabled) return `${base} ${BUTTON_DISABLED}`;
  if (state === true) return `${base} bg-accent text-white`;
  if (state === 'mixed') return `${base} bg-bg-muted text-fg hover:bg-accent/50`;
  return `${base} ${BUTTON_IDLE}`;
}

export function tableGridAlignButtonClass(disabled: boolean, active: boolean): string {
  const base = BUTTON_BASE;
  if (disabled) return `${base} ${BUTTON_DISABLED}`;
  if (active) return `${base} bg-accent text-white`;
  return `${base} ${BUTTON_IDLE}`;
}

export function tableGridColorButtonClass(disabled: boolean, extraBase = ''): string {
  const base = `${BUTTON_BASE}${extraBase}`;
  return disabled ? `${base} ${BUTTON_DISABLED}` : `${base} ${BUTTON_IDLE}`;
}

export function tableGridSwatchColor(value: string | null | 'mixed', fallback: string): string {
  return (typeof value === 'string' ? value : null) || fallback;
}

export function tableGridFindWidth(
  searchActive: boolean,
  openWidth: number,
  collapsedWidth: number
): number {
  return searchActive ? openWidth : collapsedWidth;
}
