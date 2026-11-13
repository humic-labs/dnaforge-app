export const CONVERSATION_LEDGER_SCHEMA_VERSION = 1 as const;

export const CONVERSATION_LEDGER_DIRNAME = 'conversation-ledger';
export const CONVERSATION_LEDGER_EVENTS_DIRNAME = 'conversations';
export const CONVERSATION_LEDGER_MANIFEST_FILENAME = 'manifest.json';

export const CONVERSATION_LEDGER_SHADOW = `
TEMPORARY SHADOW PHASE.
The filesystem conversation event ledger is the FUTURE source of truth.
The SQLite chat read path is LEGACY and will be retired at v2 read-cutover.
Do NOT build new chat features assuming the SQLite read path is permanent.
Exit criterion: offline projection parity proven across captured turns.
Read-cutover requires offline projection parity.
`.trim();
