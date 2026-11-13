import type { DBEntityReference } from '../../db/entity-references';
import { encodeAgentActivityMessage } from './agent-activity-message';
import type { ConversationSummary } from './orchestration/chat-store-types';
import type { ChatMessage } from './orchestration/chat-types';
import { serializeTextThreadMarkdown, serializeThreadMarkdown } from './export-thread-markdown';

const conversation: ConversationSummary = {
  id: 'conversation-2305',
  title: 'Explain the assembly plan',
  workspacePath: '/workspaces/alpha',
  pinned: false,
  provider: 'openai',
  model: 'gpt-5.6',
  createdAt: 1,
  updatedAt: 9,
};

function message(
  id: string,
  role: ChatMessage['role'],
  content: string,
  createdAt: number,
  extra: Partial<ChatMessage> = {}
): ChatMessage {
  return { id, role, content, createdAt, ...extra };
}

function reference(
  id: string,
  displayLabel: string,
  locator = `dnaforge://reference/${id}`
): DBEntityReference {
  return {
    id,
    entity_type: 'design',
    display_label: displayLabel,
    locator,
    deep_link_params: null,
    data: null,
    source: 'test',
    status: 'created',
    workspace_scope: null,
    created_at: 1,
    updated_at: 1,
  };
}

function exportThread(
  messages: ChatMessage[],
  referencesByMessageId: ReadonlyMap<string, readonly DBEntityReference[]> = new Map()
): string {
  return serializeThreadMarkdown({
    conversation,
    messages,
    referencesByMessageId,
    timeZone: 'America/Los_Angeles',
  });
}

function exportTextThread(messages: ChatMessage[]): string {
  return serializeTextThreadMarkdown({
    conversation,
    messages,
    timeZone: 'America/Los_Angeles',
  });
}

describe('serializeTextThreadMarkdown ', () => {
  it('keeps only title and timestamped prompt/final-response text', () => {
    const markdown = exportTextThread([
      message('u1', 'user', 'Inspect the construct.', Date.parse('2026-08-18T02:42:00Z')),
      message(
        'thinking-1',
        'assistant',
        'I will inspect the construct first.',
        Date.parse('2026-08-18T02:42:05Z')
      ),
      message(
        'activity-1',
        'activity',
        encodeAgentActivityMessage({
          transport: 'codex-sdk',
          sequence: 1,
          receivedAt: '2026-08-18T02:42:10.000Z',
          providerEventType: 'item.completed',
          display: { kind: 'tool', title: 'Read workspace', status: 'completed' },
          toolCalls: [
            {
              id: 'call-text-copy',
              name: 'get_workspace',
              mcpServer: 'dnaforge',
              status: 'completed',
              output: { privateResult: 'TOOL_RESULT_MUST_NOT_COPY' },
            },
          ],
          raw: { privateDetail: 'RAW_ACTIVITY_MUST_NOT_COPY' },
          versions: { sdkVersion: null, cliVersion: null },
        }),
        Date.parse('2026-08-18T02:42:10Z')
      ),
      message(
        'tool-1',
        'tool',
        JSON.stringify({ output: { privateResult: 'MATERIALIZED_TOOL_MUST_NOT_COPY' } }),
        Date.parse('2026-08-18T02:42:20Z'),
        { toolName: 'get_workspace', toolCallId: 'call-text-copy' }
      ),
      message(
        'a1',
        'assistant',
        'The construct is valid.[[ref:00000000-0000-4000-8000-000000000001]]',
        Date.parse('2026-08-18T02:43:00Z')
      ),
    ]);

    expect(markdown).toBe(
      '# Explain the assembly plan\n\n' +
        '## Prompt — 2026-08-17 19:42 PDT\n\n' +
        'Inspect the construct.\n\n' +
        '## Response — 2026-08-17 19:43 PDT\n\n' +
        'The construct is valid.\n'
    );
    expect(markdown).not.toMatch(/Thinking|Tool:|Entities and files/);
    expect(markdown).not.toMatch(
      /I will inspect|TOOL_RESULT_MUST_NOT_COPY|RAW_ACTIVITY_MUST_NOT_COPY|MATERIALIZED_TOOL_MUST_NOT_COPY|\[\[ref:/
    );
  });

  it('removes app-generated attachment framing, filenames, and file contents', () => {
    const markdown = exportTextThread([
      message(
        'u-text-file',
        'user',
        'Compare this to the control.\n\nAttached files:\n--- File: private-plan.md ---\nPRIVATE_TEXT_FILE_CONTENT',
        Date.parse('2026-08-18T02:42:00Z')
      ),
      message(
        'a-text-file',
        'assistant',
        'The comparison is complete.',
        Date.parse('2026-08-18T02:43:00Z')
      ),
      message(
        'u-file-only',
        'user',
        'Please analyze the following file:\n\n--- File: secret-sequence.gb ---\nPRIVATE_FILE_ONLY_CONTENT',
        Date.parse('2026-08-18T03:00:00Z')
      ),
      message(
        'a-file-only',
        'assistant',
        'The file-only answer remains visible.',
        Date.parse('2026-08-18T03:01:00Z')
      ),
    ]);

    expect(markdown).toContain('Compare this to the control.');
    expect(markdown).toContain('The comparison is complete.');
    expect(markdown).toContain('## Prompt — 2026-08-17 20:00 PDT\n\n_(empty message)_');
    expect(markdown).toContain('The file-only answer remains visible.');
    expect(markdown).not.toMatch(
      /Attached files|Please analyze the following file|private-plan\.md|secret-sequence\.gb|PRIVATE_TEXT_FILE_CONTENT|PRIVATE_FILE_ONLY_CONTENT/
    );
  });
});

describe('serializeThreadMarkdown ', () => {
  it('exports a title-only, turn-based transcript with compact DST-aware timestamps', () => {
    const markdown = exportThread([
      message('u1', 'user', 'Use **Gibson assembly**.', Date.parse('2026-08-18T02:42:00Z')),
      message(
        'a1',
        'assistant',
        '1. Keep this list\n2. Preserve the Markdown.',
        Date.parse('2026-08-18T02:43:00Z')
      ),
      message('u2', 'user', 'What changes?', Date.parse('2026-01-15T20:05:00Z')),
      message(
        'a2',
        'assistant',
        'Nothing in the retained order.',
        Date.parse('2026-01-15T20:06:00Z')
      ),
    ]);

    expect(markdown).toBe(
      '# Explain the assembly plan\n\n' +
        '## Prompt — 2026-08-17 19:42 PDT\n\n' +
        'Use **Gibson assembly**.\n\n' +
        '## Response — 2026-08-17 19:43 PDT\n\n' +
        '1. Keep this list\n2. Preserve the Markdown.\n\n' +
        '## Prompt — 2026-01-15 12:05 PST\n\n' +
        'What changes?\n\n' +
        '## Response — 2026-01-15 12:06 PST\n\n' +
        'Nothing in the retained order.\n'
    );
    expect(markdown).not.toMatch(
      /Conversation ID|Exported:|App version|Workspace:|Surface:|Provider:|Model:/
    );
  });

  it('keeps visible thinking and one reconciled minimal tool call in chronological order', () => {
    const requested = encodeAgentActivityMessage({
      transport: 'codex-sdk',
      sequence: 1,
      receivedAt: '2026-08-18T02:42:10.000Z',
      providerEventType: 'item.started',
      providerItemType: 'mcp_tool_call',
      providerItemId: 'provider-call-1',
      display: { kind: 'tool', title: 'Read workspace', status: 'requested' },
      toolCalls: [
        {
          id: 'call-1',
          name: 'get_workspace',
          mcpServer: 'dnaforge',
          status: 'requested',
          input: { designId: 'design-7' },
        },
      ],
      raw: { hidden: 'RAW_PROVIDER_CANARY_7F3A' },
      versions: { sdkVersion: null, cliVersion: null },
    });
    const completed = encodeAgentActivityMessage({
      transport: 'codex-sdk',
      sequence: 2,
      receivedAt: '2026-08-18T02:42:20.000Z',
      providerEventType: 'item.completed',
      providerItemType: 'mcp_tool_call',
      providerItemId: 'provider-call-1',
      display: { kind: 'tool', title: 'Read workspace', status: 'completed' },
      toolCalls: [
        {
          id: 'call-1',
          name: 'get_workspace',
          mcpServer: 'dnaforge',
          status: 'completed',
          output: { name: 'Alpha' },
        },
      ],
      raw: { hidden: 'RAW_COMPLETION_CANARY_8C4B' },
      versions: { sdkVersion: null, cliVersion: null },
    });

    const markdown = exportThread([
      message('u1', 'user', 'Inspect the workspace.', Date.parse('2026-08-18T02:42:00Z')),
      message(
        'thinking-1',
        'assistant',
        'I will inspect the retained workspace.',
        Date.parse('2026-08-18T02:42:05Z')
      ),
      message('activity-requested', 'activity', requested, Date.parse('2026-08-18T02:42:10Z')),
      message('activity-completed', 'activity', completed, Date.parse('2026-08-18T02:42:20Z')),
      message(
        'tool-row',
        'tool',
        JSON.stringify({ input: { designId: 'design-7' }, output: { name: 'Alpha' } }),
        Date.parse('2026-08-18T02:42:20Z'),
        { toolName: 'get_workspace', toolCallId: 'call-1' }
      ),
      message('a1', 'assistant', 'Done.', Date.parse('2026-08-18T02:43:00Z')),
    ]);

    expect(markdown.match(/^### Tool: get_workspace$/gm)).toHaveLength(1);
    expect(markdown).toContain('### Thinking\n\nI will inspect the retained workspace.');
    expect(markdown).toContain('**Arguments:** designId=design-7');
    expect(markdown).toContain('**Result**\n\n```json\n{\n  "name": "Alpha"\n}\n```');
    expect(markdown.indexOf('### Thinking')).toBeLessThan(markdown.indexOf('### Tool'));
    expect(markdown.indexOf('### Tool')).toBeLessThan(markdown.indexOf('## Response'));
    expect(markdown).not.toMatch(/Call ID|MCP server|\*\*Status:\*\*/);
    expect(markdown).not.toContain('RAW_PROVIDER_CANARY_7F3A');
    expect(markdown).not.toContain('RAW_COMPLETION_CANARY_8C4B');
  });

  it('reduces recognized MCP execution envelopes to one semantic result', () => {
    const semanticResult = {
      focusedPanelId: 'main',
      folders: [{ name: 'My Workspace', path: '/workspaces/current' }],
      panels: [{ id: 'main', tabs: [{ label: 'New Chat', type: 'chat' }] }],
    };
    const duplicatedText = JSON.stringify({
      jobId: 'job-internal-2305',
      ok: true,
      pool: 'cpu_fast',
      result: {
        audit_id: 'audit-internal-2305',
        ok: true,
        result: semanticResult,
      },
      status: 'completed',
      toolName: 'get_workspace',
    });
    const markdown = exportThread([
      message('u1', 'user', 'Inspect the workspace.', Date.parse('2026-08-18T02:42:00Z')),
      message(
        'tool-1',
        'tool',
        JSON.stringify({
          input: {},
          output: {
            content: [{ type: 'text', text: duplicatedText }],
            _meta: {
              'com.dnaforge/job': {
                jobId: 'job-internal-2305',
                toolName: 'get_workspace',
                status: 'completed',
                pool: 'cpu_fast',
              },
            },
            structured_content: {
              audit_id: 'audit-internal-2305',
              ok: true,
              result: semanticResult,
            },
          },
          isError: false,
        }),
        Date.parse('2026-08-18T02:42:30Z'),
        { toolName: 'get_workspace', toolCallId: 'call-1' }
      ),
      message('a1', 'assistant', 'Done.', Date.parse('2026-08-18T02:43:00Z')),
    ]);

    expect(markdown).toContain('"focusedPanelId": "main"');
    expect(markdown).toContain('"name": "My Workspace"');
    expect(markdown.match(/"focusedPanelId": "main"/g)).toHaveLength(1);
    expect(markdown).not.toMatch(
      /structured_content|job-internal-2305|audit-internal-2305|cpu_fast|com\.dnaforge\/job/
    );
    expect(markdown).not.toContain('"content":');
    expect(markdown).not.toContain('"_meta":');
    expect(markdown).not.toContain('"status": "completed"');
    expect(markdown).not.toContain('"toolName": "get_workspace"');
    expect(markdown).not.toContain('**Arguments');
  });

  it('inlines short scalar arguments and keeps complex or long arguments as JSON', () => {
    const markdown = exportThread([
      message('u1', 'user', 'Run argument shapes.', Date.parse('2026-08-18T02:42:00Z')),
      message(
        'tool-flat',
        'tool',
        JSON.stringify({
          input: {
            designId: 'design-7',
            includeHidden: false,
            limit: 3,
            offset: null,
            query: 'alpha beta',
          },
          output: 'flat done',
        }),
        Date.parse('2026-08-18T02:42:10Z'),
        { toolName: 'flat_tool', toolCallId: 'call-flat' }
      ),
      message(
        'tool-nested',
        'tool',
        JSON.stringify({
          input: { selection: { start: 1, end: 2 } },
          output: 'nested done',
        }),
        Date.parse('2026-08-18T02:42:20Z'),
        { toolName: 'nested_tool', toolCallId: 'call-nested' }
      ),
      message(
        'tool-long',
        'tool',
        JSON.stringify({
          input: { query: 'x'.repeat(180) },
          output: 'long done',
        }),
        Date.parse('2026-08-18T02:42:30Z'),
        { toolName: 'long_tool', toolCallId: 'call-long' }
      ),
      message('a1', 'assistant', 'Done.', Date.parse('2026-08-18T02:43:00Z')),
    ]);

    expect(markdown).toContain(
      '**Arguments:** designId=design-7, includeHidden=false, limit=3, offset=null, query="alpha beta"'
    );
    expect(markdown).toContain(
      '**Arguments**\n\n```json\n{\n  "selection": {\n    "start": 1,\n    "end": 2\n  }\n}\n```'
    );
    expect(markdown).toContain(`"query": "${'x'.repeat(180)}"`);
    expect(markdown.match(/^\*\*Arguments:\*\*/gm)).toHaveLength(1);
    expect(markdown.match(/^\*\*Arguments\*\*$/gm)).toHaveLength(2);
  });

  it('quotes strings that resemble JSON primitives while leaving typed scalars compact', () => {
    const markdown = exportThread([
      message('u1', 'user', 'Run typed scalar arguments.', Date.parse('2026-08-18T02:42:00Z')),
      message(
        'tool-typed-scalars',
        'tool',
        JSON.stringify({
          input: {
            textInteger: '3',
            textBoolean: 'true',
            textNull: 'null',
            textExponent: '1e3',
            realInteger: 3,
            realBoolean: true,
            realNull: null,
          },
          output: 'done',
        }),
        Date.parse('2026-08-18T02:42:10Z'),
        { toolName: 'typed_scalar_tool', toolCallId: 'call-typed-scalars' }
      ),
      message('a1', 'assistant', 'Done.', Date.parse('2026-08-18T02:43:00Z')),
    ]);

    expect(markdown).toContain(
      '**Arguments:** textInteger="3", textBoolean="true", textNull="null", textExponent="1e3", realInteger=3, realBoolean=true, realNull=null'
    );
  });

  it('normalizes camel-case and text-only MCP results without flattening domain data', () => {
    const markdown = exportThread([
      message('u1', 'user', 'Run three tools.', Date.parse('2026-08-18T02:42:00Z')),
      message(
        'tool-camel',
        'tool',
        JSON.stringify({
          output: {
            content: [{ type: 'text', text: 'duplicated' }],
            structuredContent: {
              ok: true,
              result: { value: 'semantic-camel' },
              audit_id: 'audit-camel-2305',
            },
          },
        }),
        Date.parse('2026-08-18T02:42:10Z'),
        { toolName: 'camel_tool', toolCallId: 'call-camel' }
      ),
      message(
        'tool-text',
        'tool',
        JSON.stringify({
          output: {
            content: [{ type: 'text', text: 'Plain semantic result' }],
          },
        }),
        Date.parse('2026-08-18T02:42:20Z'),
        { toolName: 'text_tool', toolCallId: 'call-text' }
      ),
      message(
        'tool-domain',
        'tool',
        JSON.stringify({
          output: {
            result: { score: 0.99 },
            label: 'A legitimate domain result',
          },
        }),
        Date.parse('2026-08-18T02:42:30Z'),
        { toolName: 'domain_tool', toolCallId: 'call-domain' }
      ),
      message(
        'tool-domain-identity-collision',
        'tool',
        JSON.stringify({
          output: {
            toolName: 'domain-scorer',
            result: { score: 0.75 },
            hits: ['alpha', 'beta'],
          },
        }),
        Date.parse('2026-08-18T02:42:40Z'),
        { toolName: 'domain_identity_tool', toolCallId: 'call-domain-identity' }
      ),
      message(
        'tool-domain-structured-collision',
        'tool',
        JSON.stringify({
          output: {
            structuredContent: { value: 'nested-domain-value' },
            label: 'A domain object with structured content',
          },
        }),
        Date.parse('2026-08-18T02:42:50Z'),
        { toolName: 'domain_structured_tool', toolCallId: 'call-domain-structured' }
      ),
      message('a1', 'assistant', 'Done.', Date.parse('2026-08-18T02:43:00Z')),
    ]);

    expect(markdown).toContain('"value": "semantic-camel"');
    expect(markdown).not.toContain('audit-camel-2305');
    expect(markdown).toContain('Plain semantic result');
    expect(markdown).not.toContain('"content":');
    expect(markdown).toMatch(/"result": \{\n\s+"score": 0\.99\n\s+\}/);
    expect(markdown).toContain('"label": "A legitimate domain result"');
    expect(markdown).toContain('"toolName": "domain-scorer"');
    expect(markdown).toContain('"hits": [');
    expect(markdown).toContain('"structuredContent": {');
    expect(markdown).toContain('"label": "A domain object with structured content"');
  });

  it('lists structured and explicit entities/files once, after their first message', () => {
    const alpha = reference('ref-alpha', 'Alpha construct');
    const puc19 = reference('ref-puc19', 'pUC19');
    const report = reference('ref-report', 'result-report.md');
    const markdown = exportThread(
      [
        message(
          'u1',
          'user',
          'Use pUC19 with `src/assembly.ts`.\n\n--- File: protocol.pdf ---\n\nSee [Benchling record](https://example.test/design/1).',
          Date.parse('2026-08-18T02:42:00Z')
        ),
        message(
          'a1',
          'assistant',
          'I used src/assembly.ts and pUC19 for BetaDesign.',
          Date.parse('2026-08-18T02:43:00Z')
        ),
      ],
      new Map([
        ['u1', [alpha, puc19]],
        ['a1', [puc19, report]],
      ])
    );

    const promptReferences =
      '### Entities and files\n\n' +
      '- Alpha construct\n' +
      '- pUC19\n' +
      '- src/assembly.ts\n' +
      '- protocol.pdf\n' +
      '- Benchling record';
    expect(markdown).toContain(promptReferences);
    expect(markdown.match(/^- pUC19$/gm)).toHaveLength(1);
    expect(markdown.match(/^- src\/assembly\.ts$/gm)).toHaveLength(1);
    expect(markdown.match(/^### Entities and files$/gm)).toHaveLength(2);
    expect(markdown.indexOf('## Response')).toBeLessThan(markdown.indexOf('- result-report.md'));
    expect(markdown).not.toContain('- BetaDesign');
  });

  it('does not guess entities from plain prose names', () => {
    const markdown = exportThread([
      message(
        'u1',
        'user',
        'Compare pUC19 with BetaDesign and Gibson assembly at https://example.test/design/1.',
        Date.parse('2026-08-18T02:42:00Z')
      ),
      message('a1', 'assistant', 'No explicit references.', Date.parse('2026-08-18T02:43:00Z')),
    ]);

    expect(markdown).not.toContain('### Entities and files');
  });

  it('uses safe fences, redacts sensitive values, and marks only failed tools as errors', () => {
    const markdown = exportThread([
      message('u1', 'user', 'Run the fenced tool.', Date.parse('2026-08-18T02:42:00Z')),
      message(
        'tool-1',
        'tool',
        JSON.stringify({
          input: { authorization: 'CANARY_VALUE_7F3A' },
          output: { report: 'keeps ```` nested fences', password: 'CANARY_VALUE_8C4B' },
          isError: true,
        }),
        Date.parse('2026-08-18T02:42:30Z'),
        { toolName: 'fenced_tool', toolCallId: 'call-fenced' }
      ),
      message('a1', 'assistant', 'It failed safely.', Date.parse('2026-08-18T02:43:00Z')),
    ]);

    expect(markdown).toContain('**Error:** Tool failed.');
    expect(markdown).toContain('`````json');
    expect(markdown).toContain('keeps ```` nested fences');
    expect(markdown).not.toContain('CANARY_VALUE_7F3A');
    expect(markdown).not.toContain('CANARY_VALUE_8C4B');
    expect(markdown).toContain('[redacted]');
  });

  it('marks a retained tool request that has no completion or result as incomplete', () => {
    const requested = encodeAgentActivityMessage({
      transport: 'codex-sdk',
      sequence: 1,
      receivedAt: '2026-08-18T02:42:10.000Z',
      providerEventType: 'item.started',
      providerItemType: 'mcp_tool_call',
      providerItemId: 'provider-call-incomplete',
      display: { kind: 'tool', title: 'Read workspace', status: 'requested' },
      toolCalls: [
        {
          id: 'call-incomplete',
          name: 'get_workspace',
          mcpServer: 'dnaforge',
          status: 'requested',
          input: { designId: 'design-7' },
        },
      ],
      raw: {},
      versions: { sdkVersion: null, cliVersion: null },
    });
    const markdown = exportThread([
      message('u1', 'user', 'Inspect the workspace.', Date.parse('2026-08-18T02:42:00Z')),
      message('activity-requested', 'activity', requested, Date.parse('2026-08-18T02:42:10Z')),
    ]);

    expect(markdown).toContain('### Tool: get_workspace');
    expect(markdown).toContain('**Incomplete:** No retained result.');
    expect(markdown).not.toContain('**Error:** Tool failed.');
  });

  it('applies the existing free-text redaction boundary to copied visible text and names', () => {
    const markdown = serializeThreadMarkdown({
      conversation: {
        ...conversation,
        title: 'token: WAYPOINT_REDACTION_CANARY_2305',
      },
      messages: [
        message(
          'u1',
          'user',
          'Email alice@example.com and keep **Markdown**.',
          Date.parse('2026-08-18T02:42:00Z')
        ),
        message(
          'a1',
          'assistant',
          'Saved `/Users/alice/research/report.md`.',
          Date.parse('2026-08-18T02:43:00Z')
        ),
      ],
      timeZone: 'America/Los_Angeles',
    });

    expect(markdown).toContain('# token: [redacted]');
    expect(markdown).toContain('Email [redacted-email] and keep **Markdown**.');
    expect(markdown).toContain('Saved `/Users/[redacted-user]/research/report.md`.');
    expect(markdown).toContain('- /Users/[redacted-user]/research/report.md');
    expect(markdown).not.toContain('WAYPOINT_REDACTION_CANARY_2305');
    expect(markdown).not.toContain('alice@example.com');
    expect(markdown).not.toContain('/Users/alice');
  });

  it('exports visible sanitized activity but excludes provider raw and unsupported roles', () => {
    const visibleError = encodeAgentActivityMessage({
      transport: 'claude-agent-sdk',
      sequence: 4,
      receivedAt: '2026-08-18T02:42:04.000Z',
      providerEventType: 'turn.failed',
      display: {
        kind: 'error',
        title: 'Tool could not finish',
        status: 'failed',
        text: 'Try the action again.',
        visibility: 'chat',
      },
      raw: { privateDetail: 'RAW_ERROR_CANARY_9D5C' },
      versions: { sdkVersion: null, cliVersion: null },
      terminal: 'failed',
    });
    const forgedSystem = {
      id: 'forged-system',
      role: 'system',
      content: 'SYSTEM_CANARY_6E2A',
      createdAt: 1,
    } as unknown as ChatMessage;

    const markdown = exportThread([
      forgedSystem,
      message('u1', 'user', 'Continue.', Date.parse('2026-08-18T02:42:00Z')),
      message('activity-error', 'activity', visibleError, Date.parse('2026-08-18T02:42:04Z')),
      message('a1', 'assistant', 'Stopped.', Date.parse('2026-08-18T02:43:00Z')),
    ]);

    expect(markdown).toContain('### Thinking\n\n**Error:** Tool could not finish');
    expect(markdown).toContain('Try the action again.');
    expect(markdown).not.toContain('RAW_ERROR_CANARY_9D5C');
    expect(markdown).not.toContain('SYSTEM_CANARY_6E2A');
  });

  it('represents an empty transcript and does not truncate large retained threads', () => {
    expect(exportThread([])).toBe('# Explain the assembly plan\n\n_No retained messages._\n');

    const largeBody = `${'retained line\n'.repeat(12_000)}FINAL_SENTINEL_2305`;
    const markdown = exportThread([
      message('a-large', 'assistant', largeBody, Date.parse('2026-08-18T02:43:00Z')),
    ]);

    expect(markdown).toContain('FINAL_SENTINEL_2305');
    expect(markdown.length).toBeGreaterThan(largeBody.length);
  });
});
