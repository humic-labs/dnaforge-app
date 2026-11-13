let promptFenceNonceCounter = 0;

export function escapePromptXml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

export function nextPromptFenceNonce(): string {
  promptFenceNonceCounter = (promptFenceNonceCounter + 1) % Number.MAX_SAFE_INTEGER;
  return `${Date.now().toString(36)}${promptFenceNonceCounter.toString(36)}${Math.random()
    .toString(36)
    .slice(2, 10)}`;
}

export function serializePromptDataFence(
  prefix: 'wp-sel' | 'wp-conversation' | 'wp-conversation-delta',
  payload: unknown,
  nonce = nextPromptFenceNonce()
): string {
  return `<${prefix}-${nonce} trust="untrusted-data">${escapePromptXml(
    JSON.stringify(payload)
  )}</${prefix}-${nonce}>`;
}

export function serializeCurrentUserRequest(
  content: string,
  nonce = nextPromptFenceNonce()
): string {
  const prefix = 'wp-current-user-request';
  return `<${prefix}-${nonce} role="user">${escapePromptXml(
    JSON.stringify({ schemaVersion: 1, role: 'user', content })
  )}</${prefix}-${nonce}>`;
}
