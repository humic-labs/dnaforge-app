import { FILE_ASSOCIATION_FAMILIES } from '../shared/file-associations';
import { TERMINAL_SETTINGS_TARGETS } from '../features/terminal/terminal-settings-fields';

export interface SettingsSectionMeta {
  label: string;
  scope?: string;
  description?: string;
  aliases: string;
}

export const SETTINGS_SECTIONS = {
  account: {
    label: 'Profile',
    scope: 'Your account',
    description: 'Your DNAForge profile across signed-in devices.',
    aliases: 'name photo avatar email sign out',
  },
  privacy: {
    label: 'Privacy',
    scope: 'Your account',
    description: 'Research participation for your account.',
    aliases: 'research contribution',
  },
  ai: {
    label: 'AI',
    aliases:
      'assistant artificial intelligence host new messages conversations credentials app access device',
  },
  integrations: {
    label: 'Integrations',
    aliases:
      'compute providers prediction protein jobs connections api keys mcp device provider account',
  },
  workspace: {
    label: 'Workspace',
    scope: 'Open projects',
    description: 'Projects open on this device and their local file locations.',
    aliases: 'folders directory paths files import reference',
  },
  'file-handling': {
    label: 'File Handling',
    scope: 'This device',
    description: 'Default apps and read-only previews for supported sequence files.',
    aliases: `default app open with file associations import edit ${FILE_ASSOCIATION_FAMILIES.map(
      (family) => `${family.displayName} ${family.extensions.join(' ')}`
    ).join(' ')}`,
  },
  registry: {
    label: 'Registry',
    aliases:
      'schema schemas default custom fields definitions versions entity links organization registration custody identifiers',
  },
  migrations: {
    label: 'Migrations',
    scope: 'Destination project',
    description: 'Import into the project selected for each migration.',
    aliases: 'benchling import history transfer',
  },
  appearance: {
    label: 'Appearance',
    scope: 'This device',
    description: 'Display preferences for this installation of DNAForge.',
    aliases: 'display interface',
  },
  editor: {
    label: 'Editor',
    scope: 'This device',
    description: 'Editor preferences are not available yet.',
    aliases: 'text code',
  },
  terminal: {
    label: 'Terminal',
    scope: 'This device',
    description: 'Appearance, input, sessions and shell profiles for the integrated terminal.',
    aliases: 'shell console command line graphics gpu fonts ligatures history restore keyboard',
  },
  shortcuts: {
    label: 'Shortcuts',
    scope: 'Reference',
    description: 'Available keyboard shortcuts. This page does not change key bindings.',
    aliases: 'keyboard hotkeys key bindings commands',
  },
  about: {
    label: 'About',
    scope: 'This installation',
    description: 'Build information and release history for this application.',
    aliases: 'version build release notes changelog help privacy policy licenses open source',
  },
  'primer-tm': {
    label: 'Primer Tm',
    scope: 'This device',
    description: 'Defaults for supported primer melting-temperature calculations on this device.',
    aliases:
      'melting temperature concentration salt magnesium thermodynamics model santa lucia owczarzy neb',
  },
  'organization-general': {
    label: 'General',
    scope: 'Organization',
    description: 'Identity and administration for the selected organization.',
    aliases: 'name url slug role delete lab',
  },
  'organization-sync-health': {
    label: 'Sync health',
    scope: 'Organization',
    description: 'Synchronization status for the selected organization.',
    aliases: 'sync errors conflicts',
  },
  'organization-provisioning': {
    label: 'Directory sync',
    scope: 'Organization',
    description: 'Provisioning and group-to-role mappings for the selected organization.',
    aliases: 'scim sso workos provisioning groups directory identity',
  },
  'organization-members': {
    label: 'People',
    scope: 'Organization',
    description: 'Members, invitations and roles in the selected organization.',
    aliases: 'members invitations invite permissions access leave owner admin',
  },
  'organization-invitations': {
    label: 'Invites',
    scope: 'Organization',
    description: 'Invitations to the selected organization.',
    aliases: 'invitations pending members',
  },
  'organization-audit': {
    label: 'Audit log',
    scope: 'Organization',
    description: 'Activity recorded for the selected organization.',
    aliases: 'audit events history csv export',
  },
  'organization-create': {
    label: 'Create organization',
    scope: 'Your account',
    description: 'Create a new organization with your account as owner.',
    aliases: 'new lab team',
  },
} as const satisfies Record<string, SettingsSectionMeta>;

export type SettingsNavId = keyof typeof SETTINGS_SECTIONS;

interface SettingTarget {
  section: SettingsNavId;
  title: string;
  description?: string;
  aliases?: string;
  available?: boolean;
  desktopOnly?: boolean;
}

export const SETTINGS_TARGETS = {
  ...TERMINAL_SETTINGS_TARGETS,
  'terminal-startup': {
    section: 'terminal',
    title: 'Terminal panel at startup',
    aliases: 'visibility startup hidden visible',
  },
  'terminal-save-sessions': {
    section: 'terminal',
    title: 'Save terminal sessions',
    description:
      'Keep terminal output between app launches. Turning this off deletes the saved terminal output.',
    aliases: 'persist restore checkpoint',
  },
  'terminal-revive-sessions': {
    section: 'terminal',
    title: 'Start shells for restored sessions',
    description:
      'When off, restored output stays readable. Use Relaunch when you want a new shell.',
    aliases: 'revive reconnect restart',
  },
  'terminal-history': {
    section: 'terminal',
    title: 'Recent history entries per shell',
    description:
      'Set 0 to clear this list and stop saving recent commands and folders. Terminal output and the shell’s own history files are unaffected.',
    aliases: 'command directory history limit',
  },
  'terminal-close-confirmation': {
    section: 'terminal',
    title: 'Confirm before closing a busy terminal',
    aliases: 'running process close warning',
  },
  'terminal-exit-notice': {
    section: 'terminal',
    title: 'Notify when a shell exits with an error',
    aliases: 'failure exit notification',
  },
  'terminal-environment': {
    section: 'terminal',
    title: 'Inherit the application environment',
    description:
      'New shells receive DNAForge’s environment. When off, they receive essential system paths and explicit profile values.',
    aliases: 'inherit environment variables',
  },
  'terminal-locale': {
    section: 'terminal',
    title: 'Locale for new shells',
    aliases: 'utf8 language locale',
  },
  'terminal-unicode': {
    section: 'terminal',
    title: 'Unicode widths',
    description:
      'Applies to new or relaunched terminals. Existing screens keep their original spacing.',
    aliases: 'unicode version character width',
  },
  'terminal-tabs': {
    section: 'terminal',
    title: 'Tab spacing',
    description:
      'Applies to new or relaunched terminals. Existing screens keep their original spacing.',
    aliases: 'tab stop width spacing',
  },
  'terminal-profiles': {
    section: 'terminal',
    title: 'Shell profiles',
    description: 'Choose a custom shell and its startup arguments. Changes apply to new terminals.',
    aliases: 'shell executable arguments environment profiles default',
  },
  theme: {
    section: 'appearance',
    title: 'Theme',
    description: 'Color scheme for the interface',
    aliases: 'dark light system mode',
  },
  'fragment-colors': {
    section: 'appearance',
    title: 'Fragment Colors',
    description: 'Provenance palette for assembly, primer, digest, and map highlights',
    aliases: 'colour color scheme',
  },
  'display-scale': {
    section: 'appearance',
    title: 'Display Scale',
    description: 'Scale the entire interface (text, images, canvas)',
    aliases: 'zoom size magnification',
  },
  'webgl-performance': {
    section: 'appearance',
    title: 'WebGL Performance',
    description: 'Auto uses full-quality rendering; Stability is diagnostic only',
    aliases: 'gpu graphics quality stability',
  },
  'reduced-motion': {
    section: 'appearance',
    title: 'Reduced Motion',
    description: 'Minimize animations',
    aliases: 'animation accessibility',
    available: false,
  },
  'font-family': {
    section: 'editor',
    title: 'Font Family',
    description: 'Monospace font for code',
    aliases: 'typeface typography',
    available: false,
  },
  'tab-size': {
    section: 'editor',
    title: 'Tab Size',
    aliases: 'indent spaces indentation',
    available: false,
  },
  'word-wrap': {
    section: 'editor',
    title: 'Word Wrap',
    description: 'Wrap long lines in the editor',
    aliases: 'wrapping',
    available: false,
  },
  'ai-host': {
    section: 'ai',
    title: 'Host',
    aliases: 'assistant provider model direct api key codex claude grok execution new messages',
    desktopOnly: true,
  },
  'ai-skills': {
    section: 'ai',
    title: 'Skills',
    aliases: 'capabilities tools instructions',
    desktopOnly: true,
  },
  'app-permissions': {
    section: 'ai',
    title: 'App permissions',
    aliases: 'mcp grants tokens external clients access revoke apps scripts review',
    desktopOnly: true,
  },
  'profile-photo': { section: 'account', title: 'Photo', aliases: 'avatar picture image' },
  'profile-name': { section: 'account', title: 'Display name', aliases: 'profile name' },
  'profile-email': { section: 'account', title: 'Email', aliases: 'email address' },
  'organization-name': {
    section: 'organization-general',
    title: 'Name',
    aliases: 'organization lab name',
  },
  'organization-url': { section: 'organization-general', title: 'URL', aliases: 'slug address' },
  'release-notes': {
    section: 'about',
    title: 'Release notes',
    aliases: 'changelog releases updates history',
  },
  'open-source-licenses': {
    section: 'about',
    title: 'Open-source licenses',
    aliases:
      'licenses open source third party notices acknowledgements credits copyright gpl source code',
  },
  'usage-analytics': {
    section: 'about',
    title: 'Share usage analytics and crash reports',
    aliases:
      'privacy analytics telemetry tracking crash reports diagnostics session replay opt out opt in consent',
    desktopOnly: true,
  },
} satisfies Record<string, SettingTarget>;

export type SettingsTargetId = keyof typeof SETTINGS_TARGETS;

export function settingsRowProps(id: SettingsTargetId) {
  const target: SettingTarget = SETTINGS_TARGETS[id];
  return { targetId: id, label: target.title, description: target.description };
}

export function settingsSubsectionProps(id: SettingsTargetId) {
  const { label, ...props } = settingsRowProps(id);
  return { ...props, title: label };
}

export interface SettingsSearchResult {
  id: string;
  section: SettingsNavId;
  title: string;
  description?: string;
  scope?: string;
  targetId?: string;
  available: boolean;
}

function normalize(value: string): string {
  return value
    .toLocaleLowerCase()
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
}

export function searchSettings(
  query: string,
  permittedSections: readonly SettingsNavId[],
  {
    hostedBrowser = false,
    computeProviders = [],
  }: {
    hostedBrowser?: boolean;
    computeProviders?: ReadonlyArray<{ id: string; displayName: string; summary: string }>;
  } = {}
): SettingsSearchResult[] {
  const tokens = normalize(query).split(' ').filter(Boolean);
  if (!tokens.length) return [];
  const results: Array<SettingsSearchResult & { score: number }> = [];
  for (const section of permittedSections) {
    const meta: SettingsSectionMeta = SETTINGS_SECTIONS[section];
    const candidates: Array<{ result: SettingsSearchResult; aliases: string }> = [
      {
        result: {
          id: section,
          section,
          title: meta.label,
          description: meta.description,
          scope: meta.scope,
          available: true,
        },
        aliases: meta.aliases,
      },
    ];
    for (const [id, target] of Object.entries<SettingTarget>(SETTINGS_TARGETS)) {
      if (target.section !== section || (hostedBrowser && target.desktopOnly)) continue;
      candidates.push({
        result: {
          id,
          section,
          title: target.title,
          description: target.description ?? meta.description,
          scope: meta.scope,
          targetId: id as SettingsTargetId,
          available: target.available !== false,
        },
        aliases: target.aliases ?? '',
      });
    }
    if (section === 'integrations') {
      for (const provider of computeProviders) {
        candidates.push({
          result: {
            id: `compute-provider-${provider.id}`,
            section,
            title: provider.displayName,
            description: provider.summary,
            scope: meta.scope,
            targetId: `compute-provider-${provider.id}`,
            available: true,
          },
          aliases: 'connect connection api key compute provider',
        });
      }
    }
    for (const { result, aliases } of candidates) {
      const title = normalize(result.title);
      const haystack = normalize(
        `${meta.label} ${result.title} ${result.description ?? ''} ${aliases}`
      );
      if (!tokens.every((token) => haystack.includes(token))) continue;
      results.push({
        ...result,
        score:
          title === normalize(query)
            ? 3
            : tokens.every((t) => title.includes(t))
              ? 2
              : result.targetId
                ? 1
                : 0,
      });
    }
  }
  return results.sort((a, b) => b.score - a.score);
}
