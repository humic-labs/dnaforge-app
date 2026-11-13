export type ShortcutModifier = 'cmd' | 'ctrl' | 'shift' | 'alt';
export type ShortcutKey = string;
export type ShortcutToken = ShortcutModifier | ShortcutKey;
export type ShortcutChord = readonly ShortcutToken[];

export type ShortcutDefinition = ShortcutChord | { apple: ShortcutChord; standard: ShortcutChord };

const MODIFIERS = new Set<string>(['cmd', 'ctrl', 'shift', 'alt']);
const MAC_MODIFIER_ORDER: readonly ShortcutModifier[] = ['cmd', 'alt', 'shift', 'ctrl'];
const STANDARD_MODIFIER_ORDER: readonly ShortcutModifier[] = ['cmd', 'ctrl', 'shift', 'alt'];

const MAC_MODIFIER_LABEL: Record<ShortcutModifier, string> = {
  cmd: '⌘',
  ctrl: '⌃',
  shift: '⇧',
  alt: '⌥',
};
const STANDARD_MODIFIER_LABEL: Record<ShortcutModifier, string> = {
  cmd: 'Ctrl',
  ctrl: 'Ctrl',
  shift: 'Shift',
  alt: 'Alt',
};

const NAMED_KEY_LABEL: Record<string, { mac: string; standard: string }> = {
  enter: { mac: '↩', standard: 'Enter' },
  return: { mac: '↩', standard: 'Enter' },
  delete: { mac: '⌫', standard: 'Del' },
  backspace: { mac: '⌫', standard: 'Backspace' },
  escape: { mac: 'Esc', standard: 'Esc' },
  tab: { mac: '⇥', standard: 'Tab' },
  space: { mac: '␣', standard: 'Space' },
  arrowup: { mac: '↑', standard: '↑' },
  arrowdown: { mac: '↓', standard: '↓' },
  arrowleft: { mac: '←', standard: '←' },
  arrowright: { mac: '→', standard: '→' },
};

type MaybeBrowserGlobals = {
  document?: unknown;
  navigator?: { platform?: unknown; userAgentData?: { platform?: unknown } };
};

function firstUsablePlatformString(...readings: unknown[]): string {
  for (const reading of readings) {
    if (typeof reading === 'string' && reading !== '') return reading;
  }
  return '';
}

function getCurrentPlatform(): string {
  const scope: MaybeBrowserGlobals = globalThis;
  if (scope.document === undefined || scope.navigator === undefined) return '';
  return firstUsablePlatformString(
    scope.navigator.platform,
    scope.navigator.userAgentData?.platform
  );
}

export function isApplePlatform(platform = getCurrentPlatform()): boolean {
  return /mac|iphone|ipad|ipod/i.test(platform);
}

function isModifier(token: string): token is ShortcutModifier {
  return MODIFIERS.has(token);
}

function resolveChord(def: ShortcutDefinition, apple: boolean): ShortcutChord {
  if ('apple' in def) return apple ? def.apple : def.standard;
  return def;
}

function keyLabel(key: string, apple: boolean): string {
  const named = NAMED_KEY_LABEL[key.toLowerCase()];
  if (named) return apple ? named.mac : named.standard;
  return key.length === 1 ? key.toUpperCase() : key;
}

function orderTokens(chord: ShortcutChord, apple: boolean): string[] {
  const order = apple ? MAC_MODIFIER_ORDER : STANDARD_MODIFIER_ORDER;
  const modifiers = order.filter((m) => chord.includes(m));
  const keys = chord.filter((t) => !isModifier(t));
  return [...modifiers, ...keys];
}

export function formatShortcutParts(
  def: ShortcutDefinition | undefined,
  platform?: string
): string[] | undefined {
  if (!def) return undefined;
  const apple = isApplePlatform(platform);
  const chord = resolveChord(def, apple);
  const labels = orderTokens(chord, apple).map((token) =>
    isModifier(token)
      ? apple
        ? MAC_MODIFIER_LABEL[token]
        : STANDARD_MODIFIER_LABEL[token]
      : keyLabel(token, apple)
  );
  return labels.filter((label, index) => labels.indexOf(label) === index);
}

export function formatShortcut(
  def: ShortcutDefinition | undefined,
  platform?: string
): string | undefined {
  const parts = formatShortcutParts(def, platform);
  if (!parts) return undefined;
  return parts.join(isApplePlatform(platform) ? '' : '+');
}

export type CommandModifierLike = {
  metaKey: boolean;
  ctrlKey: boolean;
};

export type ShortcutEventLike = CommandModifierLike & {
  key: string;
  shiftKey: boolean;
  altKey: boolean;
};

export function hasCommandModifier(event: CommandModifierLike, platform?: string): boolean {
  return isApplePlatform(platform) ? event.metaKey : event.ctrlKey;
}

export function matchesShortcut(
  event: ShortcutEventLike,
  def: ShortcutDefinition,
  platform?: string
): boolean {
  const apple = isApplePlatform(platform);
  const chord = resolveChord(def, apple);

  const wantsCmd = chord.includes('cmd');
  const wantsCtrl = chord.includes('ctrl');
  const wantsShift = chord.includes('shift');
  const wantsAlt = chord.includes('alt');

  const wantMeta = apple ? wantsCmd : false;
  const wantCtrl = apple ? wantsCtrl : wantsCmd || wantsCtrl;
  if (event.metaKey !== wantMeta) return false;
  if (event.ctrlKey !== wantCtrl) return false;
  if (event.shiftKey !== wantsShift) return false;
  if (event.altKey !== wantsAlt) return false;

  const keyToken = chord.find((t) => !isModifier(t));
  if (keyToken === undefined) return false;
  return event.key.toLowerCase() === keyToken.toLowerCase();
}

export type PointerModifierLike = {
  metaKey?: boolean;
  ctrlKey?: boolean;
  button?: number;
};

export function hasPlatformCommandModifier(event: PointerModifierLike, platform?: string): boolean {
  return isApplePlatform(platform) ? Boolean(event.metaKey) : Boolean(event.ctrlKey);
}

export function isAppleControlPrimaryClick(event: PointerModifierLike, platform?: string): boolean {
  return isApplePlatform(platform) && event.button === 0 && Boolean(event.ctrlKey);
}
