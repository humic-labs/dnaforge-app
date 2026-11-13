export interface AgentReachRoot {
  path: string;
  name: string;
}

export const AGENT_CHAT_FILES_SEGMENTS = ['cli-scratch', 'chats'] as const;

export const AGENT_CHAT_FILES_LABEL = 'Chat files';

const CONVERSATION_FOLDER_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

export function isAgentChatFolderId(value: string): boolean {
  return CONVERSATION_FOLDER_ID.test(value) && value !== '.' && value !== '..';
}

export function agentChatFilesRoot(appDataDir: string): string {
  const separator = appDataDir.includes('\\') && !appDataDir.includes('/') ? '\\' : '/';
  return [appDataDir.replace(/[\\/]+$/, ''), ...AGENT_CHAT_FILES_SEGMENTS].join(separator);
}

export function agentShortcutName(name: string): string {
  const cleaned = Array.from(name, (character) => {
    const code = character.charCodeAt(0);
    return code < 32 || code === 127 || '/\\:'.includes(character) ? ' ' : character;
  })
    .join('')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^\.+/, '')
    .trim();
  return cleaned.slice(0, 120) || 'Project';
}
