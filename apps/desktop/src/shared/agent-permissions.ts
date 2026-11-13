export type AgentShellSupervision = 'auto' | 'destructive-only' | 'always';

export const AGENT_PERMISSION_KEYS = ['claude', 'grok', 'codex'] as const;
export type AgentPermissionKey = (typeof AGENT_PERMISSION_KEYS)[number];

export type AgentPermissions = { readonly [K in AgentPermissionKey]?: string };
export type ResolvedAgentPermissions = Required<AgentPermissions> & {
  readonly codexApproval?: string;
  readonly codexReviewer?: string;
};

export interface AgentPermissionChoice {
  readonly value: string;
  readonly label: string;
  readonly description?: string;
}

export type AgentPermissionOptions = {
  readonly [K in AgentPermissionKey]: readonly AgentPermissionChoice[];
};

export interface AgentPermissionCatalog {
  readonly defaults: Required<AgentPermissions>;
  readonly options: AgentPermissionOptions;
}

interface CodexMenuItem extends AgentPermissionChoice {
  readonly description: string;
  readonly profile: string;
  readonly approvalPolicy: string;
  readonly approvalsReviewer: string;
}

export const CODEX_MENU: readonly CodexMenuItem[] = [
  {
    value: ':ask-for-approval',
    label: 'Ask for approval',
    description:
      'Read and edit workspace files and run commands, with approval required for internet access or edits outside the workspace',
    profile: ':workspace',
    approvalPolicy: 'on-request',
    approvalsReviewer: 'user',
  },
  {
    value: ':approve-for-me',
    label: 'Approve for me',
    description: 'Only ask for actions detected as potentially unsafe',
    profile: ':workspace',
    approvalPolicy: 'on-request',
    approvalsReviewer: 'auto_review',
  },
  {
    value: ':danger-full-access',
    label: 'Full Access',
    description:
      'Use with caution: Codex can edit files outside this workspace and access the internet without approval',
    profile: ':danger-full-access',
    approvalPolicy: 'never',
    approvalsReviewer: 'user',
  },
  {
    value: ':read-only',
    label: 'Read Only',
    description: 'Read workspace files, with approval required for edits or internet access',
    profile: ':read-only',
    approvalPolicy: 'on-request',
    approvalsReviewer: 'user',
  },
];

export function codexMenuItem(choice: string): CodexMenuItem | undefined {
  return CODEX_MENU.find((item) => item.value === choice);
}

export function codexProfile(choice: string): string {
  return codexMenuItem(choice)?.profile ?? choice;
}

export function codexChoice(item: AgentPermissionChoice): AgentPermissionChoice {
  return item.description
    ? { value: item.value, label: item.label, description: item.description }
    : { value: item.value, label: item.label };
}

export function codexCustomProfileChoice(
  id: string,
  description?: string | null
): AgentPermissionChoice {
  return { value: id, label: id, description: description ?? 'Configured permission profile' };
}

const CLI_MODE_NAMES: Readonly<
  Record<'claude' | 'grok', readonly (readonly [word: string, name: string | null])[]>
> = {
  claude: [
    ['manual', 'Manual mode'],
    ['default', 'Manual mode'],
    ['acceptEdits', 'Accept edits'],
    ['plan', 'Plan mode'],
    ['bypassPermissions', 'Bypass permissions'],
    ['auto', 'Auto mode'],
    ['dontAsk', "Don't ask"],
  ],
  grok: [
    ['default', 'Normal'],
    ['plan', 'Plan'],
    ['auto', 'Auto-review'],
    ['bypassPermissions', 'Always-Approve'],
    ['acceptEdits', null],
    ['dontAsk', null],
  ],
};

export function cliModeChoices(
  family: 'claude' | 'grok',
  words: readonly string[]
): AgentPermissionChoice[] {
  const names = CLI_MODE_NAMES[family];
  const entry = (word: string) => names.find(([known]) => known === word);
  const rank = (word: string) => {
    const index = names.findIndex(([known]) => known === word);
    return index < 0 ? names.length : index;
  };
  return words
    .filter((word) => entry(word)?.[1] !== null)
    .sort((left, right) => rank(left) - rank(right))
    .map((word) => ({ value: word, label: entry(word)?.[1] ?? word }));
}

export const BUILT_IN_AGENT_PERMISSIONS: ResolvedAgentPermissions = {
  claude: 'manual',
  grok: 'default',
  codex: ':read-only',
};

export const BUILT_IN_AGENT_PERMISSION_CATALOG: AgentPermissionCatalog = {
  defaults: BUILT_IN_AGENT_PERMISSIONS,
  options: {
    claude: cliModeChoices('claude', [
      'acceptEdits',
      'auto',
      'bypassPermissions',
      'manual',
      'dontAsk',
      'plan',
    ]),
    grok: cliModeChoices('grok', [
      'default',
      'acceptEdits',
      'auto',
      'dontAsk',
      'bypassPermissions',
      'plan',
    ]),
    codex: CODEX_MENU.filter((item) => item.value !== ':approve-for-me').map(codexChoice),
  },
};

const PERMISSION_WORD = /^[A-Za-z0-9:][\w:.-]{0,63}$/;

export function isPermissionWord(value: unknown): value is string {
  return typeof value === 'string' && PERMISSION_WORD.test(value);
}

export function parseAgentPermissions(value: unknown): AgentPermissions | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const parsed: Record<string, string> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (!(AGENT_PERMISSION_KEYS as readonly string[]).includes(key)) continue;
    if (!isPermissionWord(entry)) return null;
    parsed[key] = entry;
  }
  return parsed as AgentPermissions;
}

export function resolveAgentPermissions(
  catalog: AgentPermissionCatalog,
  ...layers: readonly (AgentPermissions | null | undefined)[]
): ResolvedAgentPermissions {
  const pick = (key: AgentPermissionKey): string =>
    layers
      .map((layer) => layer?.[key])
      .reverse()
      .find(
        (word) => word !== undefined && catalog.options[key].some((choice) => choice.value === word)
      ) ?? catalog.defaults[key];
  return { claude: pick('claude'), grok: pick('grok'), codex: pick('codex') };
}

export function launchAgentPermissions(
  catalog: AgentPermissionCatalog,
  requested: AgentPermissions | undefined
): ResolvedAgentPermissions {
  const permissions = resolveAgentPermissions(catalog, requested);
  const item =
    permissions.codex === catalog.defaults.codex ? undefined : codexMenuItem(permissions.codex);
  return item
    ? {
        ...permissions,
        codexApproval: item.approvalPolicy,
        codexReviewer: item.approvalsReviewer,
      }
    : permissions;
}

export type AgentPermissionFamily = 'claude' | 'grok' | 'codex';

export function permissionFamilyForTransport(
  transport: 'codex-sdk' | 'claude-agent-sdk' | 'grok-acp'
): AgentPermissionFamily {
  if (transport === 'claude-agent-sdk') return 'claude';
  if (transport === 'grok-acp') return 'grok';
  return 'codex';
}

export interface AgentPermissionPicker {
  readonly key: AgentPermissionKey;
  readonly label: string;
  readonly testId: string;
}

export const AGENT_PERMISSION_PICKERS: Readonly<
  Record<AgentPermissionFamily, readonly AgentPermissionPicker[]>
> = {
  claude: [
    {
      key: 'claude',
      label: 'Claude permission mode',
      testId: 'chat-permission-mode-select',
    },
  ],
  grok: [
    {
      key: 'grok',
      label: 'Grok permission mode',
      testId: 'chat-permission-mode-select',
    },
  ],
  codex: [
    {
      key: 'codex',
      label: 'Codex permissions',
      testId: 'chat-codex-permissions-select',
    },
  ],
};

export interface DnaforgeSupervision {
  readonly shellSupervision: AgentShellSupervision;
  readonly askBeforeWrites: boolean;
  readonly skipConfirmations: boolean;
}

const SKIP: DnaforgeSupervision = {
  shellSupervision: 'auto',
  askBeforeWrites: false,
  skipConfirmations: true,
};
const ASK_ALL: DnaforgeSupervision = {
  shellSupervision: 'always',
  askBeforeWrites: true,
  skipConfirmations: false,
};
const ASK_COMMANDS: DnaforgeSupervision = {
  shellSupervision: 'always',
  askBeforeWrites: false,
  skipConfirmations: false,
};
const ASK_DESTRUCTIVE: DnaforgeSupervision = {
  shellSupervision: 'destructive-only',
  askBeforeWrites: false,
  skipConfirmations: false,
};

export function dnaforgeSupervision(
  family: AgentPermissionFamily,
  permissions: ResolvedAgentPermissions
): DnaforgeSupervision {
  if (family === 'codex') {
    const profile = codexProfile(permissions.codex);
    if (profile === ':danger-full-access') return SKIP;
    if (profile === ':read-only') return ASK_ALL;
    return ASK_DESTRUCTIVE;
  }
  const mode = family === 'claude' ? permissions.claude : permissions.grok;
  if (mode === 'bypassPermissions') return SKIP;
  if (mode === 'default' || mode === 'manual' || mode === 'plan') return ASK_ALL;
  if (mode === 'acceptEdits') return ASK_COMMANDS;
  return ASK_DESTRUCTIVE;
}

export function claudeSessionPermissionMode(mode: string, interactive: boolean): string {
  return interactive || mode === 'bypassPermissions' ? mode : 'dontAsk';
}

export function codexSessionApprovalPolicy(
  policy: string | undefined,
  interactive: boolean
): string | undefined {
  return interactive ? policy : 'never';
}
