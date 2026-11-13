import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

import {
  publicAgentApprovalRule,
  type AgentApprovalChoice,
  type AgentApprovalRule,
} from '../../shared/agent-approval';

export interface AlwaysAllowRule extends AgentApprovalRule {
  enabled: boolean;
  createdAt: number;
}

export interface ApprovalMemory {
  allows(conversationId: string | null | undefined, key: string): boolean;
  remember(
    choice: AgentApprovalChoice,
    conversationId: string | null | undefined,
    rule: AgentApprovalRule
  ): void;
  alwaysRules(): AlwaysAllowRule[];
  setAlwaysRuleEnabled(key: string, enabled: boolean): AlwaysAllowRule[];
  removeAlwaysRule(key: string): AlwaysAllowRule[];
}

export interface AlwaysAllowStore {
  load(): AlwaysAllowRule[];
  save(rules: readonly AlwaysAllowRule[]): void;
}

function isRule(value: unknown): value is AlwaysAllowRule {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const rule = value as Record<string, unknown>;
  return (
    typeof rule.key === 'string' &&
    rule.key.length > 0 &&
    rule.key.length <= 4096 &&
    typeof rule.label === 'string' &&
    typeof rule.enabled === 'boolean' &&
    typeof rule.createdAt === 'number'
  );
}

export function createJsonAlwaysAllowStore(file: string): AlwaysAllowStore {
  return {
    load() {
      try {
        const parsed: unknown = JSON.parse(readFileSync(file, 'utf8'));
        const rules =
          parsed && typeof parsed === 'object' && !Array.isArray(parsed)
            ? (parsed as { rules?: unknown }).rules
            : null;
        return Array.isArray(rules) ? rules.filter(isRule) : [];
      } catch {
        return [];
      }
    },
    save(rules) {
      mkdirSync(dirname(file), { recursive: true });
      const temporary = `${file}.${process.pid}.tmp`;
      writeFileSync(temporary, JSON.stringify({ version: 1, rules }, null, 2));
      renameSync(temporary, file);
    },
  };
}

export function createApprovalMemory(
  store: AlwaysAllowStore,
  now: () => number = Date.now
): ApprovalMemory {
  const chatAllows = new Map<string, Set<string>>();
  let rules: AlwaysAllowRule[] | null = null;
  const loaded = (): AlwaysAllowRule[] =>
    (rules ??= store.load().map((rule) => ({ ...rule, ...publicAgentApprovalRule(rule) })));

  return {
    allows(conversationId, key) {
      if (conversationId && chatAllows.get(conversationId)?.has(key)) return true;
      return loaded().some((rule) => rule.enabled && rule.key === key);
    },
    remember(choice, conversationId, rule) {
      if (choice === 'chat' && conversationId) {
        const keys = chatAllows.get(conversationId) ?? new Set<string>();
        keys.add(rule.key);
        chatAllows.set(conversationId, keys);
        return;
      }
      if (choice !== 'always') return;
      const current = loaded();
      const existing = current.find((entry) => entry.key === rule.key);
      rules = existing
        ? current.map((entry) => (entry.key === rule.key ? { ...entry, enabled: true } : entry))
        : [...current, { ...rule, enabled: true, createdAt: now() }];
      store.save(rules);
    },
    alwaysRules() {
      return loaded().map((rule) => ({ ...rule }));
    },
    setAlwaysRuleEnabled(key, enabled) {
      rules = loaded().map((rule) => (rule.key === key ? { ...rule, enabled } : rule));
      store.save(rules);
      return rules.map((rule) => ({ ...rule }));
    },
    removeAlwaysRule(key) {
      rules = loaded().filter((rule) => rule.key !== key);
      store.save(rules);
      return rules.map((rule) => ({ ...rule }));
    },
  };
}

let defaultMemory: ApprovalMemory | null = null;

export function setDefaultApprovalMemory(memory: ApprovalMemory | null): void {
  defaultMemory = memory;
}

export function defaultApprovalMemory(): ApprovalMemory | null {
  return defaultMemory;
}
