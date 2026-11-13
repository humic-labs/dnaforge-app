import { describe, expect, it } from 'vitest';
import { getHostedNativeToolDefinition } from '@waypoint/hosted-ai-contract';

import {
  CLAUDE_NATIVE_CHAT_ALLOWED_TOOLS,
  CLAUDE_RUNTIME_TOOL_POLICY,
  CODEX_RUNTIME_DISCOVERY_EXCEPTION,
  CODEX_SDK_THREAD_ITEM_POLICY,
  HOSTED_EQUIVALENTS_FOR_CODEX_ITEM,
  HOSTED_CLAUDE_CAPABILITY_EXCEPTIONS,
  HOSTED_EQUIVALENTS_FOR_CLAUDE_TOOL,
  type ActiveCodexThreadItemType,
} from '../native-tool-capabilities';

describe('native Ask AI capability policy', () => {
  it('derives the Claude app allowlist only from explicitly active runtime tools', () => {
    expect(CLAUDE_NATIVE_CHAT_ALLOWED_TOOLS).toEqual(
      Object.entries(CLAUDE_RUNTIME_TOOL_POLICY)
        .filter(([, policy]) => policy.status === 'active')
        .map(([name]) => name)
    );
    expect(CLAUDE_NATIVE_CHAT_ALLOWED_TOOLS).toEqual(
      expect.arrayContaining([
        'Bash',
        'CronCreate',
        'CronDelete',
        'CronList',
        'ScheduleWakeup',
        'TaskOutput',
        'TaskStop',
        'NotebookEdit',
        'TaskCreate',
        'TaskGet',
        'TaskList',
        'TaskUpdate',
        'WebFetch',
        'WebSearch',
      ])
    );
    expect(CLAUDE_NATIVE_CHAT_ALLOWED_TOOLS).not.toEqual(
      expect.arrayContaining(['BashOutput', 'KillShell', 'MultiEdit', 'NotebookRead', 'TodoWrite'])
    );
  });

  it('maps every active Claude tool to Hosted or one narrow reviewed exception', () => {
    expect(Object.keys(HOSTED_EQUIVALENTS_FOR_CLAUDE_TOOL).sort()).toEqual(
      [...CLAUDE_NATIVE_CHAT_ALLOWED_TOOLS].sort()
    );
    for (const toolName of CLAUDE_NATIVE_CHAT_ALLOWED_TOOLS) {
      const equivalents = HOSTED_EQUIVALENTS_FOR_CLAUDE_TOOL[toolName];
      if (equivalents.length === 0) {
        expect(HOSTED_CLAUDE_CAPABILITY_EXCEPTIONS[toolName]).toMatchObject({
          owner: expect.any(String),
          reason: expect.any(String),
          removalCondition: expect.any(String),
        });
      } else {
        expect(HOSTED_CLAUDE_CAPABILITY_EXCEPTIONS[toolName]).toBeUndefined();
        for (const equivalent of equivalents) {
          expect(getHostedNativeToolDefinition(equivalent)).not.toBeNull();
        }
      }
    }
    expect(Object.keys(HOSTED_CLAUDE_CAPABILITY_EXCEPTIONS).sort()).toEqual([
      'CronCreate',
      'CronDelete',
      'CronList',
      'EnterPlanMode',
      'Monitor',
      'PushNotification',
      'ScheduleWakeup',
      'Task',
      'WebSearch',
    ]);
  });

  it('gives every unavailable native Claude tool an owner, visible reason, and removal condition', () => {
    for (const [toolName, policy] of Object.entries(CLAUDE_RUNTIME_TOOL_POLICY)) {
      if (policy.status !== 'provider-runtime-internal') continue;
      expect(policy, toolName).toMatchObject({
        owner: expect.any(String),
        reason: expect.any(String),
        userVisibleReason: expect.any(String),
        removalCondition: expect.any(String),
      });
    }
  });

  it('classifies every Codex SDK thread item and maps each effect capability', () => {
    expect(Object.keys(CODEX_SDK_THREAD_ITEM_POLICY)).toEqual([
      'agent_message',
      'reasoning',
      'command_execution',
      'file_change',
      'mcp_tool_call',
      'web_search',
      'todo_list',
      'error',
    ]);

    const effectItems = Object.entries(CODEX_SDK_THREAD_ITEM_POLICY)
      .filter(([, policy]) => policy.status === 'active-effect')
      .map(([itemType]) => itemType as ActiveCodexThreadItemType);
    expect(Object.keys(HOSTED_EQUIVALENTS_FOR_CODEX_ITEM)).toEqual(effectItems);

    for (const itemType of effectItems) {
      const equivalents = HOSTED_EQUIVALENTS_FOR_CODEX_ITEM[itemType];
      expect(equivalents).toMatchObject({ kind: expect.any(String) });
      if (equivalents.kind !== 'native-tools') continue;
      for (const equivalent of equivalents.tools) {
        expect(getHostedNativeToolDefinition(equivalent)).not.toBeNull();
      }
    }

    expect(HOSTED_EQUIVALENTS_FOR_CODEX_ITEM.web_search).toEqual({
      kind: 'reviewed-exception',
      exception: HOSTED_CLAUDE_CAPABILITY_EXCEPTIONS.WebSearch,
    });
    expect(CODEX_RUNTIME_DISCOVERY_EXCEPTION).toMatchObject({
      owner: 'Desktop AI',
      reason: expect.stringContaining('does not emit a startup native-tool inventory'),
      removalCondition: expect.any(String),
    });
  });
});
