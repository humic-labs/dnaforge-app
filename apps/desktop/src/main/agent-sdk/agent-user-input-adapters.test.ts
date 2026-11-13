import { describe, expect, it, vi } from 'vitest';

import {
  answerClaudeAskUserQuestion,
  answerClaudePlanDecision,
  answerCodexMcpElicitation,
  answerCodexRequestUserInput,
  answerCodexServerApproval,
  askAgentApproval,
  answerGrokElicitation,
  answerGrokPermissionRequest,
  type RequestAgentUserInput,
} from './agent-user-input-adapters';
import { createApprovalMemory } from './approval-memory';

describe('answerCodexMcpElicitation', () => {
  it('preserves typed form values and defaults through the app-owned question card', async () => {
    await expect(
      answerCodexMcpElicitation({
        params: {
          mode: 'form',
          threadId: 'thread-1',
          turnId: 'turn-1',
          serverName: 'dnaforge',
          _meta: null,
          message: 'Configure the run',
          requestedSchema: {
            type: 'object',
            required: ['method', 'replicates', 'dryRun'],
            properties: {
              method: {
                type: 'string',
                title: 'Method',
                description: 'Choose the assembly method.',
                enum: ['gibson', 'golden-gate'],
                default: 'golden-gate',
              },
              replicates: {
                type: 'integer',
                title: 'Replicates',
                minimum: 1,
                maximum: 8,
                default: 3,
              },
              dryRun: { type: 'boolean', title: 'Dry run', default: true },
            },
          },
        },
        conversationId: 'conversation-1',
        signal: new AbortController().signal,
        requestUserInput: async (request) => {
          expect(request.provider).toBe('codex-sdk');
          expect(request.questions).toEqual([
            expect.objectContaining({
              id: 'method',
              defaultOptionIds: ['golden-gate'],
              allowFreeText: false,
            }),
            expect.objectContaining({ id: 'replicates', allowFreeText: true }),
            expect.objectContaining({ id: 'dryRun', defaultOptionIds: ['true'] }),
          ]);
          return {
            outcome: 'submitted',
            answers: {
              method: { selectedOptionIds: ['gibson'] },
              replicates: { selectedOptionIds: [], text: '4' },
              dryRun: { selectedOptionIds: ['false'] },
            },
          };
        },
      })
    ).resolves.toEqual({
      action: 'accept',
      content: { method: 'gibson', replicates: 4, dryRun: false },
      _meta: null,
    });
  });

  it('declines URL mode and cancels a dismissed form without inventing content', async () => {
    const common = {
      threadId: 'thread-1',
      turnId: 'turn-1',
      serverName: 'dnaforge',
      _meta: null,
      message: 'Input required',
    };
    await expect(
      answerCodexMcpElicitation({
        params: { ...common, mode: 'url', url: 'https://example.test', elicitationId: 'e-1' },
        conversationId: null,
        signal: new AbortController().signal,
        requestUserInput: vi.fn(),
      })
    ).resolves.toEqual({ action: 'decline', content: null, _meta: null });
    await expect(
      answerCodexMcpElicitation({
        params: {
          ...common,
          mode: 'form',
          requestedSchema: {
            type: 'object',
            properties: { note: { type: 'string' } },
          },
        },
        conversationId: null,
        signal: new AbortController().signal,
        requestUserInput: async () => ({ outcome: 'cancelled', answers: {} }),
      })
    ).resolves.toEqual({ action: 'cancel', content: null, _meta: null });
  });
});

describe('answerClaudePlanDecision', () => {
  const signal = new AbortController().signal;

  it('shows the proposed plan and returns approval to the same ExitPlanMode call', async () => {
    await expect(
      answerClaudePlanDecision({
        input: { plan: '1. Inspect the plasmid\n2. Design primers' },
        conversationId: 'conversation-plan',
        signal,
        requestUserInput: async (request) => {
          expect(request).toEqual({
            provider: 'claude-agent-sdk',
            conversationId: 'conversation-plan',
            questions: [
              {
                id: 'plan-decision',
                header: 'Plan',
                prompt: '1. Inspect the plasmid\n2. Design primers',
                options: [
                  { id: 'approve', label: 'Approve', description: 'Continue with this plan.' },
                  { id: 'reject', label: 'Reject', description: 'Do not execute this plan.' },
                  { id: 'edit', label: 'Request edits', description: 'Send revision feedback.' },
                ],
                multiSelect: false,
                allowFreeText: true,
              },
            ],
          });
          return {
            outcome: 'submitted',
            answers: { 'plan-decision': { selectedOptionIds: ['approve'] } },
          };
        },
      })
    ).resolves.toEqual({
      behavior: 'allow',
      updatedInput: { plan: '1. Inspect the plasmid\n2. Design primers' },
    });
  });

  it('returns edit feedback without approving the plan', async () => {
    await expect(
      answerClaudePlanDecision({
        input: { plan: 'Draft plan' },
        conversationId: null,
        signal,
        requestUserInput: async () => ({
          outcome: 'submitted',
          answers: {
            'plan-decision': {
              selectedOptionIds: ['edit'],
              text: 'Do the read-only inspection first.',
            },
          },
        }),
      })
    ).resolves.toEqual({
      behavior: 'deny',
      message: 'Revise the plan before continuing: Do the read-only inspection first.',
      interrupt: false,
    });
  });

  it('keeps rejection and cancellation distinct', async () => {
    const base = { input: { plan: 'Draft plan' }, conversationId: null, signal };
    await expect(
      answerClaudePlanDecision({
        ...base,
        requestUserInput: async () => ({
          outcome: 'submitted',
          answers: { 'plan-decision': { selectedOptionIds: ['reject'] } },
        }),
      })
    ).resolves.toEqual({
      behavior: 'deny',
      message: 'The user rejected this plan.',
      interrupt: false,
    });
    await expect(
      answerClaudePlanDecision({
        ...base,
        requestUserInput: async () => ({ outcome: 'cancelled', answers: {} }),
      })
    ).resolves.toEqual({
      behavior: 'deny',
      message: 'The user cancelled this plan decision.',
      interrupt: true,
    });
  });
});

describe('answerClaudeAskUserQuestion', () => {
  const input = {
    questions: [
      {
        question: 'Which assembly method should be used?',
        header: 'Assembly',
        options: [
          { label: 'Gibson', description: 'Overlap assembly' },
          { label: 'Golden Gate', description: 'Type IIS assembly', preview: 'BsaI → ligase' },
        ],
        multiSelect: false,
      },
      {
        question: 'Which validations should run?',
        header: 'Checks',
        options: [
          { label: 'Sequence', description: 'Validate sequence' },
          { label: 'Topology', description: 'Validate topology' },
        ],
        multiSelect: true,
      },
    ],
  };

  it('normalizes the native question and returns Claude-native answers in the same tool call', async () => {
    const requestUserInput = vi.fn(async (request) => {
      expect(request).toEqual({
        provider: 'claude-agent-sdk',
        conversationId: 'conversation-1',
        questions: [
          {
            id: 'question-0',
            header: 'Assembly',
            prompt: 'Which assembly method should be used?',
            options: [
              { id: 'option-0', label: 'Gibson', description: 'Overlap assembly' },
              {
                id: 'option-1',
                label: 'Golden Gate',
                description: 'Type IIS assembly',
                preview: 'BsaI → ligase',
              },
            ],
            multiSelect: false,
            allowFreeText: true,
          },
          {
            id: 'question-1',
            header: 'Checks',
            prompt: 'Which validations should run?',
            options: [
              { id: 'option-0', label: 'Sequence', description: 'Validate sequence' },
              { id: 'option-1', label: 'Topology', description: 'Validate topology' },
            ],
            multiSelect: true,
            allowFreeText: true,
          },
        ],
      });
      return {
        outcome: 'submitted' as const,
        answers: {
          'question-0': { selectedOptionIds: ['option-1'] },
          'question-1': { selectedOptionIds: ['option-0', 'option-1'] },
        },
      };
    });

    await expect(
      answerClaudeAskUserQuestion({
        input,
        conversationId: 'conversation-1',
        signal: new AbortController().signal,
        requestUserInput,
      })
    ).resolves.toEqual({
      behavior: 'allow',
      updatedInput: {
        ...input,
        answers: {
          'Which assembly method should be used?': 'Golden Gate',
          'Which validations should run?': 'Sequence, Topology',
        },
      },
    });
  });

  it('accepts Claude choices whose optional explanatory text is empty', async () => {
    const liveInput = {
      questions: [
        {
          question: 'Which assembly method?',
          header: 'Assembly',
          options: [
            { label: 'Gibson', description: '' },
            { label: 'Golden Gate', description: '' },
          ],
          multiSelect: false,
        },
      ],
    };
    const requestUserInput = vi.fn(async () => ({
      outcome: 'submitted' as const,
      answers: { 'question-0': { selectedOptionIds: ['option-0'] } },
    }));

    await expect(
      answerClaudeAskUserQuestion({
        input: liveInput,
        conversationId: 'conversation-live-shape',
        signal: new AbortController().signal,
        requestUserInput,
      })
    ).resolves.toEqual({
      behavior: 'allow',
      updatedInput: {
        ...liveInput,
        answers: { 'Which assembly method?': 'Gibson' },
      },
    });
    expect(requestUserInput).toHaveBeenCalledWith(
      expect.objectContaining({
        questions: [
          expect.objectContaining({
            options: [
              expect.objectContaining({ label: 'Gibson', description: '' }),
              expect.objectContaining({ label: 'Golden Gate', description: '' }),
            ],
          }),
        ],
      }),
      expect.any(AbortSignal)
    );
  });

  it('returns an interrupting denial when the user cancels', async () => {
    await expect(
      answerClaudeAskUserQuestion({
        input,
        conversationId: null,
        signal: new AbortController().signal,
        requestUserInput: async () => ({ outcome: 'cancelled', answers: {} }),
      })
    ).resolves.toEqual({
      behavior: 'deny',
      message: 'The user cancelled this question.',
      interrupt: true,
    });
  });

  it('rejects malformed provider input instead of showing invented choices', async () => {
    const requestUserInput = vi.fn();
    await expect(
      answerClaudeAskUserQuestion({
        input: { questions: [{ question: 'Missing fields' }] },
        conversationId: null,
        signal: new AbortController().signal,
        requestUserInput,
      })
    ).resolves.toMatchObject({ behavior: 'deny', interrupt: true });
    expect(requestUserInput).not.toHaveBeenCalled();
  });
});

describe('answerCodexRequestUserInput', () => {
  it('preserves native question ids and translates selected options back to labels', async () => {
    const requestUserInput = vi.fn(async (request) => {
      expect(request).toEqual({
        provider: 'codex-sdk',
        conversationId: 'conversation-2',
        questions: [
          {
            id: 'assembly',
            header: 'Assembly',
            prompt: 'Choose a method',
            options: [
              { id: 'option-0', label: 'Gibson', description: 'Overlap assembly' },
              { id: 'option-1', label: 'Golden Gate', description: 'Type IIS assembly' },
            ],
            multiSelect: false,
            allowFreeText: true,
            secret: false,
          },
          {
            id: 'notes',
            header: 'Notes',
            prompt: 'Add private notes',
            options: [],
            multiSelect: false,
            allowFreeText: true,
            secret: true,
          },
        ],
      });
      return {
        outcome: 'submitted' as const,
        answers: {
          assembly: { selectedOptionIds: ['option-1'] },
          notes: { selectedOptionIds: [], text: 'keep adapters at 20 C' },
        },
      };
    });

    await expect(
      answerCodexRequestUserInput({
        params: {
          threadId: 'thread-1',
          turnId: 'turn-1',
          itemId: 'item-1',
          isBlocking: true,
          autoResolutionMs: null,
          questions: [
            {
              id: 'assembly',
              header: 'Assembly',
              question: 'Choose a method',
              isOther: true,
              isSecret: false,
              options: [
                { label: 'Gibson', description: 'Overlap assembly' },
                { label: 'Golden Gate', description: 'Type IIS assembly' },
              ],
            },
            {
              id: 'notes',
              header: 'Notes',
              question: 'Add private notes',
              isOther: true,
              isSecret: true,
              options: null,
            },
          ],
        },
        conversationId: 'conversation-2',
        signal: new AbortController().signal,
        requestUserInput,
      })
    ).resolves.toEqual({
      answers: {
        assembly: { answers: ['Golden Gate'] },
        notes: { answers: ['keep adapters at 20 C'] },
      },
    });
  });

  it('returns empty native answers when the card is cancelled', async () => {
    await expect(
      answerCodexRequestUserInput({
        params: {
          threadId: 'thread-1',
          turnId: 'turn-1',
          itemId: 'item-1',
          isBlocking: true,
          autoResolutionMs: null,
          questions: [
            {
              id: 'q1',
              header: 'Choice',
              question: 'Choose',
              isOther: false,
              isSecret: false,
              options: [{ label: 'A', description: 'First' }],
            },
          ],
        },
        conversationId: null,
        signal: new AbortController().signal,
        requestUserInput: async () => ({ outcome: 'cancelled', answers: {} }),
      })
    ).resolves.toEqual({ answers: { q1: { answers: [] } } });
  });
});

describe('answerCodexServerApproval', () => {
  it('maps the five choices to Codex decisions and shows project names', async () => {
    const seen: Array<Parameters<RequestAgentUserInput>[0]> = [];
    const ask =
      (choice: string): RequestAgentUserInput =>
      async (request) => {
        seen.push(request);
        return { outcome: 'submitted', answers: { approval: { selectedOptionIds: [choice] } } };
      };
    const command = (choice: string) =>
      answerCodexServerApproval({
        method: 'item/commandExecution/requestApproval',
        params: {
          threadId: 'thread-1',
          turnId: 'turn-1',
          itemId: 'item-1',
          startedAtMs: 1,
          environmentId: null,
          reason: null,
          command: 'blastn -query /data/projects/a/in.fa',
          cwd: '/data/chats/conv-1',
          availableDecisions: ['accept', 'cancel'],
        },
        conversationId: 'conv-1',
        signal: new AbortController().signal,
        requestUserInput: ask(choice),
        approvalRoots: [
          { path: '/data/chats/conv-1', name: 'Chat files' },
          { path: '/data/projects/a', name: 'My Project' },
        ],
      });
    await expect(command('once')).resolves.toEqual({ decision: 'accept' });
    await expect(command('chat')).resolves.toEqual({ decision: 'accept' });
    await expect(command('deny')).resolves.toEqual({ decision: 'decline' });
    await expect(command('stop')).resolves.toEqual({ decision: 'cancel' });
    expect(seen[0].approval).toEqual({
      kind: 'command',
      title: 'Codex wants to run a command',
      detail: null,
      command: 'blastn -query My Project/in.fa',
      paths: [{ display: 'Chat files', full: '/data/chats/conv-1' }],
      rule: {
        key: 'command:blastn',
        label: 'blastn commands',
        catalogMessage: { key: 'approval.commandScope', values: { programs: 'blastn' } },
      },
    });
    expect(seen[0].questions[0].options.map((option) => option.id)).toEqual([
      'once',
      'chat',
      'always',
      'deny',
      'stop',
    ]);
  });

  it('answers a repeat request from this chat without asking again', async () => {
    const memory = createApprovalMemory({ load: () => [], save: () => undefined });
    const requestUserInput = vi.fn<RequestAgentUserInput>(async () => ({
      outcome: 'submitted',
      answers: { approval: { selectedOptionIds: ['chat'] } },
    }));
    const run = (conversationId: string) =>
      answerCodexServerApproval({
        method: 'item/commandExecution/requestApproval',
        params: {
          threadId: 'thread-1',
          turnId: 'turn-1',
          itemId: 'item-1',
          startedAtMs: 1,
          environmentId: null,
          reason: null,
          command: 'mafft in.fa',
          cwd: '/workspace',
          availableDecisions: ['accept', 'acceptForSession', 'decline', 'cancel'],
        },
        conversationId,
        signal: new AbortController().signal,
        requestUserInput,
        approvalMemory: memory,
      });
    await expect(run('conv-1')).resolves.toEqual({ decision: 'acceptForSession' });
    await expect(run('conv-1')).resolves.toEqual({ decision: 'accept' });
    expect(requestUserInput).toHaveBeenCalledTimes(1);
    await run('conv-2');
    expect(requestUserInput).toHaveBeenCalledTimes(2);
  });

  it('returns the exact command approval decision selected by the user', async () => {
    await expect(
      answerCodexServerApproval({
        method: 'item/commandExecution/requestApproval',
        params: {
          threadId: 'thread-1',
          turnId: 'turn-1',
          itemId: 'item-1',
          startedAtMs: 1,
          environmentId: null,
          reason: 'Needs network access',
          command: 'curl https://example.com',
          cwd: '/workspace',
          availableDecisions: ['accept', 'acceptForSession', 'decline', 'cancel'],
        },
        conversationId: null,
        signal: new AbortController().signal,
        requestUserInput: async () => ({
          outcome: 'submitted',
          answers: { approval: { selectedOptionIds: ['chat'] } },
        }),
      })
    ).resolves.toEqual({ decision: 'acceptForSession' });
  });

  it('fails closed on a cancelled file-change approval', async () => {
    await expect(
      answerCodexServerApproval({
        method: 'item/fileChange/requestApproval',
        params: {
          threadId: 'thread-1',
          turnId: 'turn-1',
          itemId: 'item-1',
          startedAtMs: 1,
          reason: 'Write the design',
          grantRoot: '/workspace',
        },
        conversationId: null,
        signal: new AbortController().signal,
        requestUserInput: async () => ({ outcome: 'cancelled', answers: {} }),
      })
    ).resolves.toEqual({ decision: 'cancel' });
  });

  it('grants only the requested permissions and selected scope', async () => {
    const permissions = {
      network: { enabled: true },
      fileSystem: { read: ['/reference'], write: ['/output'], entries: [] },
    };
    await expect(
      answerCodexServerApproval({
        method: 'item/permissions/requestApproval',
        params: {
          threadId: 'thread-1',
          turnId: 'turn-1',
          itemId: 'item-1',
          environmentId: null,
          startedAtMs: 1,
          cwd: '/workspace',
          reason: 'Read the reference and write the output',
          permissions,
        },
        conversationId: null,
        signal: new AbortController().signal,
        requestUserInput: async () => ({
          outcome: 'submitted',
          answers: { approval: { selectedOptionIds: ['once'] } },
        }),
      })
    ).resolves.toEqual({ permissions, scope: 'turn' });
  });
});

describe('answerGrokPermissionRequest', () => {
  it('maps the five choices onto the ACP options Grok offers', async () => {
    const params = {
      sessionId: 'grok-session',
      toolCall: {
        toolCallId: 'tool-7',
        title: 'Write the assembly plan',
        kind: 'edit' as const,
        rawInput: { path: '/workspace/plan.md' },
      },
      options: [
        { optionId: 'allow-7', name: 'Allow once', kind: 'allow_once' as const },
        { optionId: 'always-7', name: 'Always', kind: 'allow_always' as const },
        { optionId: 'reject-7', name: 'Reject', kind: 'reject_once' as const },
      ],
    };
    const answer = (choice: string) =>
      answerGrokPermissionRequest({
        params,
        conversationId: 'conversation-grok',
        signal: new AbortController().signal,
        approvalRoots: [{ path: '/workspace', name: 'My Project' }],
        requestUserInput: async (request) => {
          expect(request.approval).toMatchObject({
            kind: 'file',
            title: 'The assistant wants to change files',
            paths: [{ display: 'My Project/plan.md', full: '/workspace/plan.md' }],
            rule: { key: 'write:/workspace', label: 'changes in My Project' },
          });
          return { outcome: 'submitted', answers: { approval: { selectedOptionIds: [choice] } } };
        },
      });
    await expect(answer('once')).resolves.toEqual({
      outcome: { outcome: 'selected', optionId: 'allow-7' },
    });
    await expect(answer('chat')).resolves.toEqual({
      outcome: { outcome: 'selected', optionId: 'always-7' },
    });
    await expect(answer('deny')).resolves.toEqual({
      outcome: { outcome: 'selected', optionId: 'reject-7' },
    });
    await expect(answer('stop')).resolves.toEqual({ outcome: { outcome: 'cancelled' } });
  });

  it('cancels when the card closes or returns an unknown option', async () => {
    const base = {
      params: {
        sessionId: 'grok-session',
        toolCall: { toolCallId: 'tool-7', title: 'Run command' },
        options: [{ optionId: 'allow', name: 'Allow', kind: 'allow_once' as const }],
      },
      conversationId: null,
      signal: new AbortController().signal,
    };
    await expect(
      answerGrokPermissionRequest({
        ...base,
        requestUserInput: async () => ({ outcome: 'cancelled', answers: {} }),
      })
    ).resolves.toEqual({ outcome: { outcome: 'cancelled' } });
    await expect(
      answerGrokPermissionRequest({
        ...base,
        requestUserInput: async () => ({
          outcome: 'submitted',
          answers: { approval: { selectedOptionIds: ['invented'] } },
        }),
      })
    ).resolves.toEqual({ outcome: { outcome: 'cancelled' } });
  });
});

describe('answerGrokElicitation', () => {
  const params = {
    mode: 'form' as const,
    sessionId: 'grok-session',
    message: 'Configure the assembly run',
    requestedSchema: {
      type: 'object' as const,
      title: 'Assembly setup',
      required: ['method', 'checks', 'cycles', 'dryRun'],
      properties: {
        method: {
          type: 'string' as const,
          title: 'Method',
          description: 'Choose the assembly method.',
          oneOf: [
            { const: 'gibson', title: 'Gibson', description: 'Overlap assembly' },
            { const: 'golden-gate', title: 'Golden Gate', description: 'Type IIS assembly' },
          ],
          default: 'golden-gate',
        },
        checks: {
          type: 'array' as const,
          title: 'Checks',
          description: 'Choose validation steps.',
          items: {
            anyOf: [
              { const: 'sequence', title: 'Sequence' },
              { const: 'topology', title: 'Topology' },
            ],
          },
          default: ['sequence'],
        },
        cycles: {
          type: 'integer' as const,
          title: 'Cycles',
          description: 'PCR cycle count.',
          default: 30,
        },
        dryRun: {
          type: 'boolean' as const,
          title: 'Dry run',
          description: 'Avoid writes.',
          default: true,
        },
      },
    },
  };

  it('maps ACP forms to the shared card and restores typed values', async () => {
    await expect(
      answerGrokElicitation({
        params,
        conversationId: 'conversation-grok',
        signal: new AbortController().signal,
        requestUserInput: async (request) => {
          expect(request).toEqual({
            provider: 'grok-acp',
            conversationId: 'conversation-grok',
            questions: [
              {
                id: 'method',
                header: 'Method',
                prompt: 'Choose the assembly method.',
                options: [
                  { id: 'gibson', label: 'Gibson', description: 'Overlap assembly' },
                  {
                    id: 'golden-gate',
                    label: 'Golden Gate',
                    description: 'Type IIS assembly',
                  },
                ],
                multiSelect: false,
                allowFreeText: false,
                defaultOptionIds: ['golden-gate'],
              },
              {
                id: 'checks',
                header: 'Checks',
                prompt: 'Choose validation steps.',
                options: [
                  { id: 'sequence', label: 'Sequence', description: '' },
                  { id: 'topology', label: 'Topology', description: '' },
                ],
                multiSelect: true,
                allowFreeText: false,
                defaultOptionIds: ['sequence'],
              },
              {
                id: 'cycles',
                header: 'Cycles',
                prompt: 'PCR cycle count.\nDefault: 30',
                options: [],
                multiSelect: false,
                allowFreeText: true,
              },
              {
                id: 'dryRun',
                header: 'Dry run',
                prompt: 'Avoid writes.',
                options: [
                  { id: 'true', label: 'Yes', description: '' },
                  { id: 'false', label: 'No', description: '' },
                ],
                multiSelect: false,
                allowFreeText: false,
                defaultOptionIds: ['true'],
              },
            ],
          });
          return {
            outcome: 'submitted',
            answers: {
              method: { selectedOptionIds: ['gibson'] },
              checks: { selectedOptionIds: ['sequence', 'topology'] },
              cycles: { selectedOptionIds: [], text: '28' },
              dryRun: { selectedOptionIds: ['false'] },
            },
          };
        },
      })
    ).resolves.toEqual({
      action: 'accept',
      content: {
        method: 'gibson',
        checks: ['sequence', 'topology'],
        cycles: 28,
        dryRun: false,
      },
    });
  });

  it('declines unsupported modes and invalid required values without inventing an answer', async () => {
    const requestUserInput = vi.fn();
    await expect(
      answerGrokElicitation({
        params: { mode: 'url', requestId: 'auth', message: 'Open login', url: 'https://x.ai' },
        conversationId: null,
        signal: new AbortController().signal,
        requestUserInput,
      })
    ).resolves.toEqual({ action: 'decline' });
    expect(requestUserInput).not.toHaveBeenCalled();

    await expect(
      answerGrokElicitation({
        params,
        conversationId: null,
        signal: new AbortController().signal,
        requestUserInput: async () => ({
          outcome: 'submitted',
          answers: {
            method: { selectedOptionIds: ['gibson'] },
            checks: { selectedOptionIds: [] },
            cycles: { selectedOptionIds: [], text: 'not-a-number' },
            dryRun: { selectedOptionIds: ['true'] },
          },
        }),
      })
    ).resolves.toEqual({ action: 'decline' });
  });
});

it('denies an unavailable approval without turning its timeout into a user Stop', async () => {
  const choice = await askAgentApproval(
    {
      provider: 'codex-sdk',
      conversationId: 'conversation-1',
      signal: new AbortController().signal,
      requestUserInput: async () => ({ outcome: 'cancelled', answers: {}, reason: 'timeout' }),
    },
    {
      kind: 'command',
      title: 'Run inspection',
      detail: null,
      command: 'ps',
      paths: [],
      rule: { key: 'inspection', label: 'Inspection' },
    }
  );
  expect(choice).toBe('deny');
});
