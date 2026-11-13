import { formatShortcut as formatPlatformShortcut } from '@waypoint/ui-components/keyboard';
import { userMessageValue, type UserMessageValue } from '@waypoint/user-messages';
export {
  isApplePlatform,
  formatShortcut,
  matchesShortcut,
  hasCommandModifier,
} from '@waypoint/ui-components/keyboard';
export type {
  ShortcutKey,
  ShortcutChord,
  ShortcutDefinition,
} from '@waypoint/ui-components/keyboard';

export function formatShortcutHint(
  ...args: Parameters<typeof formatPlatformShortcut>
): UserMessageValue | undefined {
  const formatted = formatPlatformShortcut(...args);
  return formatted === undefined ? undefined : userMessageValue(formatted);
}
