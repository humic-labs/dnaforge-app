import { getSetting, setSetting } from '../db';

const noticeSettings = {
  'post-update': 'last_seen_release_version',
  'usage-analytics': 'analytics_banner_seen',
  'privacy-policy': 'privacy_policy_update_seen',
} as const;

type DesktopNotice = keyof typeof noticeSettings;

export function readNoticeVersion(notice: DesktopNotice): Promise<string | null> {
  return getSetting(noticeSettings[notice]);
}

export function rememberNotice(notice: DesktopNotice, version: string): Promise<void> {
  return setSetting(noticeSettings[notice], version);
}
