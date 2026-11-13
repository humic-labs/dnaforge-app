export type HostedNativeToolEffect = 'read-only' | 'mutating';

export interface HostedNativeToolDefinition {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: Record<string, unknown>;
  readonly effects: readonly HostedNativeToolEffect[];
}

const stringProperty = (description: string): Record<string, unknown> => ({
  type: 'string',
  description,
});

const integerProperty = (
  description: string,
  minimum: number,
  maximum: number
): Record<string, unknown> => ({
  type: 'integer',
  description,
  minimum,
  maximum,
});

const objectSchema = (
  properties: Record<string, unknown>,
  required: readonly string[]
): Record<string, unknown> => ({
  type: 'object',
  properties,
  required,
  additionalProperties: false,
});

export const HOSTED_NATIVE_TOOL_DEFINITIONS = [
  {
    name: 'Read',
    description: 'Read a bounded UTF-8 text range from a local file.',
    inputSchema: objectSchema(
      {
        file_path: stringProperty('Absolute path, or a path relative to the current workspace.'),
        offset: integerProperty('Zero-based line offset.', 0, 1_000_000),
        limit: integerProperty('Maximum number of lines to return.', 1, 5_000),
      },
      ['file_path']
    ),
    effects: ['read-only'],
  },
  {
    name: 'LS',
    description: 'List a bounded set of files and directories.',
    inputSchema: objectSchema(
      {
        path: stringProperty(
          'Absolute directory path, or a path relative to the current workspace.'
        ),
        depth: integerProperty('Maximum directory depth.', 1, 8),
      },
      []
    ),
    effects: ['read-only'],
  },
  {
    name: 'Glob',
    description: 'Find local paths that match a glob pattern.',
    inputSchema: objectSchema(
      {
        pattern: stringProperty('Glob pattern, such as **/*.gb.'),
        path: stringProperty('Absolute search root, or a path relative to the current workspace.'),
        limit: integerProperty('Maximum matching paths to return.', 1, 2_000),
      },
      ['pattern']
    ),
    effects: ['read-only'],
  },
  {
    name: 'Grep',
    description: 'Search bounded local text files for a regular expression.',
    inputSchema: objectSchema(
      {
        pattern: stringProperty('JavaScript regular expression source.'),
        path: stringProperty('Absolute search root, or a path relative to the current workspace.'),
        glob: stringProperty('Optional glob used to select files.'),
        case_sensitive: { type: 'boolean', description: 'Use case-sensitive matching.' },
        limit: integerProperty('Maximum matching lines to return.', 1, 2_000),
      },
      ['pattern']
    ),
    effects: ['read-only'],
  },
  {
    name: 'WebFetch',
    description: 'Fetch bounded readable content from a public HTTP or HTTPS URL.',
    inputSchema: objectSchema(
      {
        url: stringProperty('Public HTTP or HTTPS URL to read.'),
        prompt: stringProperty('What information to extract from the fetched content.'),
      },
      ['url', 'prompt']
    ),
    effects: ['read-only'],
  },
  {
    name: 'NotebookEdit',
    description: 'Replace, insert, or delete one exact Jupyter notebook cell.',
    inputSchema: objectSchema(
      {
        notebook_path: stringProperty(
          'Absolute notebook path, or a path relative to the current workspace.'
        ),
        cell_id: stringProperty(
          'Cell ID to replace or delete, or the cell after which a new cell is inserted.'
        ),
        new_source: stringProperty('Complete source for the cell.'),
        cell_type: {
          type: 'string',
          description: 'Cell type. Required when inserting a cell.',
          enum: ['code', 'markdown'],
        },
        edit_mode: {
          type: 'string',
          description: 'Edit operation. Defaults to replace.',
          enum: ['replace', 'insert', 'delete'],
        },
      },
      ['notebook_path', 'new_source']
    ),
    effects: ['mutating'],
  },
  {
    name: 'TaskCreate',
    description: 'Create a turn-scoped planning task.',
    inputSchema: objectSchema(
      {
        subject: stringProperty('Brief task title.'),
        description: stringProperty('What needs to be done.'),
        activeForm: stringProperty('Present continuous text shown while the task is active.'),
        metadata: {
          type: 'object',
          description: 'Optional JSON metadata for the task.',
          additionalProperties: true,
        },
      },
      ['subject', 'description']
    ),
    effects: ['read-only'],
  },
  {
    name: 'TaskGet',
    description: 'Read one planning task owned by this AI turn.',
    inputSchema: objectSchema({ taskId: stringProperty('Opaque task ID.') }, ['taskId']),
    effects: ['read-only'],
  },
  {
    name: 'TaskList',
    description: 'List planning tasks owned by this AI turn.',
    inputSchema: objectSchema({}, []),
    effects: ['read-only'],
  },
  {
    name: 'TaskUpdate',
    description: 'Update or delete one planning task owned by this AI turn.',
    inputSchema: objectSchema(
      {
        taskId: stringProperty('Opaque task ID.'),
        subject: stringProperty('New task title.'),
        description: stringProperty('New task description.'),
        activeForm: stringProperty('New present continuous activity text.'),
        status: {
          type: 'string',
          description: 'New task status. Deleted tasks are removed.',
          enum: ['pending', 'in_progress', 'completed', 'deleted'],
        },
        addBlocks: {
          type: 'array',
          description: 'Task IDs that this task blocks.',
          items: { type: 'string' },
          maxItems: 100,
        },
        addBlockedBy: {
          type: 'array',
          description: 'Task IDs that block this task.',
          items: { type: 'string' },
          maxItems: 100,
        },
        owner: stringProperty('Optional task owner label.'),
        metadata: {
          type: 'object',
          description: 'Metadata keys to merge. A null value removes a key.',
          additionalProperties: true,
        },
      },
      ['taskId']
    ),
    effects: ['read-only'],
  },
  {
    name: 'Write',
    description: 'Create or replace a UTF-8 local file.',
    inputSchema: objectSchema(
      {
        file_path: stringProperty('Absolute path, or a path relative to the current workspace.'),
        content: stringProperty('Complete UTF-8 file content.'),
      },
      ['file_path', 'content']
    ),
    effects: ['mutating'],
  },
  {
    name: 'Edit',
    description: 'Replace an exact string in an existing UTF-8 local file.',
    inputSchema: objectSchema(
      {
        file_path: stringProperty('Absolute path, or a path relative to the current workspace.'),
        old_string: stringProperty('Exact text to replace.'),
        new_string: stringProperty('Replacement text.'),
        replace_all: { type: 'boolean', description: 'Replace every exact occurrence.' },
      },
      ['file_path', 'old_string', 'new_string']
    ),
    effects: ['mutating'],
  },
  {
    name: 'MultiEdit',
    description: 'Apply an ordered list of exact string replacements to one UTF-8 local file.',
    inputSchema: objectSchema(
      {
        file_path: stringProperty('Absolute path, or a path relative to the current workspace.'),
        edits: {
          type: 'array',
          description: 'Ordered exact replacements.',
          items: objectSchema(
            {
              old_string: stringProperty('Exact text to replace.'),
              new_string: stringProperty('Replacement text.'),
              replace_all: { type: 'boolean', description: 'Replace every exact occurrence.' },
            },
            ['old_string', 'new_string']
          ),
          minItems: 1,
          maxItems: 100,
        },
      },
      ['file_path', 'edits']
    ),
    effects: ['mutating'],
  },
  {
    name: 'Move',
    description: 'Move a local file or directory to a new local path.',
    inputSchema: objectSchema(
      {
        source_path: stringProperty('Existing source path.'),
        destination_path: stringProperty('Destination path.'),
        overwrite: { type: 'boolean', description: 'Replace an existing destination.' },
      },
      ['source_path', 'destination_path']
    ),
    effects: ['mutating'],
  },
  {
    name: 'Delete',
    description: 'Move a local file or directory to the operating system trash.',
    inputSchema: objectSchema({ path: stringProperty('Existing file or directory path.') }, [
      'path',
    ]),
    effects: ['mutating'],
  },
  {
    name: 'Bash',
    description: 'Run a bounded shell command in the current workspace or app scratch directory.',
    inputSchema: objectSchema(
      {
        command: stringProperty('Exact shell command to run.'),
        timeout_ms: integerProperty('Maximum execution time in milliseconds.', 100, 120_000),
      },
      ['command']
    ),
    effects: ['mutating'],
  },
  {
    name: 'ProcessStart',
    description: 'Start a background shell command and return an opaque process handle.',
    inputSchema: objectSchema({ command: stringProperty('Exact shell command to run.') }, [
      'command',
    ]),
    effects: ['mutating'],
  },
  {
    name: 'ProcessStatus',
    description: 'Read bounded output and status for a background process owned by this AI turn.',
    inputSchema: objectSchema(
      { process_id: stringProperty('Opaque process handle returned by ProcessStart.') },
      ['process_id']
    ),
    effects: ['read-only'],
  },
  {
    name: 'ProcessStop',
    description: 'Stop a background process owned by this AI turn.',
    inputSchema: objectSchema(
      { process_id: stringProperty('Opaque process handle returned by ProcessStart.') },
      ['process_id']
    ),
    effects: ['mutating'],
  },
] as const satisfies readonly HostedNativeToolDefinition[];

export type HostedNativeToolName = (typeof HOSTED_NATIVE_TOOL_DEFINITIONS)[number]['name'];

const definitionByName = new Map<string, HostedNativeToolDefinition>(
  HOSTED_NATIVE_TOOL_DEFINITIONS.map((definition) => [definition.name, definition])
);

export function getHostedNativeToolDefinition(name: string): HostedNativeToolDefinition | null {
  return definitionByName.get(name) ?? null;
}

export function isHostedNativeToolName(name: string): name is HostedNativeToolName {
  return definitionByName.has(name);
}
