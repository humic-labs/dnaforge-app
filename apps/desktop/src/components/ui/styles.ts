export const UI_PROSE_WRAP_CLASS = 'min-w-0 whitespace-pre-wrap [overflow-wrap:anywhere]';
export const UI_ENTITY_REFERENCE_CHIP_CLASS =
  'px-[calc(0.3em+1px)] py-[calc(0.1em+1px)] text-[0.875rem] font-medium leading-[1.25rem] [transition:background-color_0.15s_ease]';
export const UI_ENTITY_REFERENCE_KIND_CLASS = 'shrink-0 text-[10px] font-medium text-fg-muted';
export const UI_PAGE_TITLE_CLASS = 'text-3xl font-bold tracking-tight text-fg';
export const UI_SUBSECTION_TITLE_CLASS = 'text-xl font-semibold tracking-tight text-fg';
export const UI_SUBSECTION_DESCRIPTION_CLASS = 'mt-1.5 text-sm leading-5 text-fg-muted';
export const UI_CONTENT_WIDTH_CLASS = 'box-content max-w-[760px]';
export const UI_FORM_WIDTH_CLASS = 'w-full min-w-0';
export const UI_FORM_LONE_FIELD_SPAN_CLASS = 'sm:[&>*:last-child:nth-child(odd)]:col-span-2';
export const UI_FORM_GRID_CLASS = `grid grid-cols-1 sm:grid-cols-2 ${UI_FORM_LONE_FIELD_SPAN_CLASS}`;
export const UI_FIELD_CLASS =
  'h-10 w-full min-w-0 rounded-md border border-transparent bg-black/[0.04] px-3 text-sm text-fg transition-colors placeholder:text-fg-subtle focus:border-accent focus:outline-none disabled:cursor-not-allowed disabled:opacity-50 dark:bg-white/[0.055]';
export const UI_TEXTAREA_CLASS =
  'w-full rounded-md border border-transparent bg-black/[0.04] px-3 py-2 text-sm leading-5 text-fg transition-colors placeholder:text-fg-subtle focus:border-accent focus:outline-none disabled:cursor-not-allowed disabled:opacity-50 dark:bg-white/[0.055]';
export const UI_SURFACE_CLASS = 'bg-black/[0.025] dark:bg-white/[0.035]';
export const UI_MODAL_LAYER_CLASS = 'z-[10000]';
export const UI_POPOVER_LAYER_CLASS = 'z-[10050]';
export const UI_SUBMENU_LAYER_CLASS = 'z-[10060]';
export const UI_CARD_CLASS = `rounded-md p-4 ${UI_SURFACE_CLASS}`;
export const UI_LIST_CLASS = `divide-y divide-border/50 overflow-hidden rounded-md ${UI_SURFACE_CLASS}`;
export const UI_SPLIT_PANEL_CLASS = `grid grid-cols-[13rem_minmax(0,1fr)] overflow-hidden ${UI_SURFACE_CLASS}`;
export const UI_SPLIT_PANEL_LIST_CLASS = 'flex min-h-0 flex-1 flex-col overflow-y-auto p-0';
export const UI_SPLIT_PANEL_EDITOR_CLASS = 'min-w-0 overflow-y-auto bg-bg';
export const UI_NAVIGATION_LIST_CLASS = UI_SPLIT_PANEL_LIST_CLASS;
export const UI_NAVIGATION_PANEL_CLASS = 'flex min-h-0 min-w-0 flex-1 flex-col text-fg';
export const UI_NAVIGATION_GROUP_CLASS = 'flex min-w-0 flex-col';
export const UI_NAVIGATION_ROW_CLASS =
  'flex min-h-9 w-full min-w-0 flex-none items-center gap-2 border-b border-border px-4 py-1.5 text-left text-xs transition-colors hover:bg-bg-muted focus-within:bg-bg-muted';
export const UI_NAVIGATION_PRIMARY_CLASS =
  'flex min-w-0 flex-1 items-center gap-2 text-left text-xs focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-accent/40 disabled:cursor-not-allowed disabled:opacity-50';
export const UI_NAVIGATION_TEXT_CLASS = 'flex min-w-0 flex-1 flex-col justify-center gap-0.5';
export const UI_NAVIGATION_LINE_CLASS = 'flex min-w-0 items-center gap-2';
export const UI_NAVIGATION_TITLE_CLASS = 'min-w-0 flex-1 truncate font-medium text-fg';
export const UI_NAVIGATION_DETAIL_CLASS = 'block min-w-0 truncate text-xs text-fg-subtle';
export const UI_NAVIGATION_METADATA_CLASS = 'shrink-0 text-xs text-fg-subtle';
export const UI_NAVIGATION_ACTIONS_CLASS = 'flex shrink-0 items-center gap-0.5';
export const UI_NAVIGATION_ACTION_CLASS =
  'inline-flex shrink-0 items-center justify-center rounded-md border border-transparent bg-black/[0.04] p-1 text-xs font-medium text-fg-muted hover:bg-black/[0.07] hover:text-fg focus-visible:bg-black/[0.07] focus-visible:text-fg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40 disabled:cursor-not-allowed disabled:opacity-50 dark:bg-white/[0.055] dark:hover:bg-white/[0.09] dark:focus-visible:bg-white/[0.09]';
export const UI_NAVIGATION_HEADER_CLASS =
  'flex shrink-0 items-center justify-between gap-2 border-b border-border px-4 py-1.5 text-xs font-semibold text-fg';
export const UI_NAVIGATION_EMPTY_CLASS = 'px-3 py-4 text-xs text-fg-muted';
export const UI_AGENT_TRACE_ROW_CLASS =
  'my-0.5 min-w-0 py-1 text-xs text-accent/80 dark:text-accent/70';
export const UI_AGENT_TRACE_MARKER_CLASS =
  'mt-[0.35rem] h-1.5 w-1.5 flex-shrink-0 rounded-full bg-accent/55 dark:bg-accent/45';
export const UI_AGENT_TRACE_TITLE_CLASS =
  'min-w-0 break-words font-medium text-accent/85 dark:text-accent/75';
export const UI_AGENT_TRACE_STATUS_CLASS =
  'flex-shrink-0 truncate text-[10px] uppercase tracking-wide text-accent/65 dark:text-accent/55';
export const UI_AGENT_TRACE_DETAIL_CLASS =
  'ml-3.5 mt-0.5 line-clamp-3 whitespace-pre-wrap break-words text-[11px] leading-4 text-accent/70 dark:text-accent/60';

export function navigationStatusClass(tone: 'neutral' | 'success' | 'warning' | 'error'): string {
  return `shrink-0 text-xs ${
    {
      neutral: 'text-fg-subtle',
      success: 'text-success',
      warning: 'text-warning',
      error: 'text-error',
    }[tone]
  }`;
}
const UI_SPLIT_PANEL_TAB_CLASS =
  'flex min-h-14 w-full flex-none items-center border-l-2 px-3 py-2 text-left transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-accent/40';

export function splitPanelTabClass(selected: boolean): string {
  return `${UI_SPLIT_PANEL_TAB_CLASS} ${
    selected
      ? 'border-accent bg-bg text-fg'
      : 'border-transparent text-fg-muted hover:bg-black/[0.04] hover:text-fg dark:hover:bg-white/[0.055]'
  }`;
}
export const UI_APPBAR_ACTION_CLASS = 'appbar-action';
export const UI_SECONDARY_BUTTON_CLASS =
  'rounded-md border border-transparent bg-black/[0.04] px-3 py-2 text-xs font-medium text-fg transition-colors hover:bg-black/[0.07] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40 disabled:cursor-not-allowed disabled:opacity-50 dark:bg-white/[0.055] dark:hover:bg-white/[0.09]';
export const UI_ICON_BUTTON_CLASS =
  'inline-flex size-8 shrink-0 items-center justify-center rounded-md border border-transparent bg-black/[0.04] p-0 text-xs font-medium text-fg transition-colors hover:bg-black/[0.07] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40 disabled:cursor-not-allowed disabled:opacity-50 dark:bg-white/[0.055] dark:hover:bg-white/[0.09]';
export const UI_PRIMARY_BUTTON_CLASS =
  'rounded-md bg-accent px-3 py-2 text-xs font-medium text-accent-fg transition-opacity hover:opacity-90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40 disabled:cursor-not-allowed disabled:opacity-50';
export const UI_DANGER_BUTTON_CLASS =
  'rounded-md border border-transparent bg-error/8 px-3 py-2 text-xs font-medium text-error transition-colors hover:bg-error/14 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-error/40 disabled:cursor-not-allowed disabled:opacity-50';
export const UI_LINK_BUTTON_CLASS =
  'rounded text-left underline decoration-dotted underline-offset-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40 disabled:cursor-not-allowed disabled:opacity-50';
export const UI_READONLY_FIELD_CLASS =
  'h-10 w-full min-w-0 rounded-md border border-transparent bg-black/[0.025] px-3 text-sm text-fg-muted focus:border-accent focus:outline-none dark:bg-white/[0.035]';
export const UI_SELECT_TRIGGER_CLASS = `${UI_FIELD_CLASS} flex items-center justify-between gap-3 text-left font-normal disabled:cursor-not-allowed disabled:opacity-50`;
export const UI_SELECT_CARET_CLASS = 'shrink-0 text-fg-subtle';
export const UI_MENU_OPTION_CLASS =
  'flex w-full min-w-0 items-center gap-3 rounded px-3 py-2 text-left text-sm transition-colors focus:outline-none';

export const UI_SEGMENTED_SURFACE_CLASS = 'flex rounded-md bg-bg-muted p-0.5';
export function segmentedOptionClass(selected: boolean): string {
  return `flex-1 rounded py-1.5 text-xs font-medium transition-all duration-150 ${
    selected ? 'bg-bg text-fg' : 'text-fg-muted hover:text-fg'
  } focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40`;
}

export const UI_DISCLOSURE_SUMMARY_CLASS =
  'min-h-6 cursor-pointer rounded px-2 py-0.5 font-medium leading-5 focus:outline-none';

export function selectableCardClass(
  tone: 'blue' | 'emerald',
  selected: boolean,
  previewed: boolean
) {
  const selectedTone =
    tone === 'blue'
      ? 'border-blue-500/60 bg-blue-500/10 ring-2 ring-blue-500/30'
      : 'border-emerald-500/60 bg-emerald-500/10 ring-2 ring-emerald-500/30';
  const idleTone =
    tone === 'blue'
      ? 'border-blue-500/30 bg-blue-500/5 hover:bg-blue-500/10'
      : 'border-emerald-500/30 bg-emerald-500/5 hover:bg-emerald-500/10';
  const toneClass = selected ? `${selectedTone} shadow-md` : `${idleTone} shadow-sm`;
  const previewClass = !selected && previewed ? 'ring-1 ring-border' : '';
  return `relative h-20 w-full overflow-hidden rounded-md border focus:bg-bg-muted focus:outline-none focus:ring-1 focus:ring-accent ${toneClass} ${previewClass}`;
}
