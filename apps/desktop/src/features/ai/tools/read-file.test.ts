import { assertMcpOutput } from '../../../test-utils/mcp-output-test-helper';
import { managedSkillLocator, type AgentManagedSkill } from '../../../shared/agent-capability-controls';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createReadFileTool } from './read-file';
import { execTool as executeTool, resetCanvasStore } from './test-helpers';
import type { WorkspaceFolder } from '../../../stores/workspaceStore';
import { useCanvasStore } from '../../canvas/store';
import { NO_WORKSPACE_TOOL_MESSAGE } from './path-utils';

const { mockPlatform } = vi.hoisted(() => {
  const readTextFile = vi.fn().mockResolvedValue('');
  const stat = vi
    .fn()
    .mockResolvedValue({ size: 1024, isFile: true, isDirectory: false, mtime: 0 });
  return {
    mockPlatform: {
      fs: {
        readTextFile,
        stat,
        readAdmittedTextFile: vi.fn(async (input: { path: string }) => readTextFile(input.path)),
      },
      agentCapabilities: {
        discover: vi.fn(),
        listManaged: vi.fn().mockResolvedValue({ commands: [], skills: [], memory: [] }),
      },
    },
  };
});

const skillCapture = vi.hoisted(() => ({ capture: vi.fn(), ready: true }));
vi.mock('../../../lib/analytics', () => ({
  trackRendererEvent: skillCapture.capture,
  isAnalyticsCaptureReady: () => skillCapture.ready,
  getAnalyticsIdentifiedAccountId: () => 'synthetic-private-account',
  subscribeAnalyticsCaptureReady: () => () => undefined,
}));

vi.mock('../../../platform', () => ({
  platform: () => mockPlatform,
  initPlatform: vi.fn().mockResolvedValue(mockPlatform),
}));

const WORKSPACE = '/home/user/lab';
const singleFolder: WorkspaceFolder[] = [{ name: 'lab', path: WORKSPACE, addedAt: 1 }];

beforeEach(() => {
  vi.clearAllMocks();
  skillCapture.ready = true; skillCapture.capture.mockReset().mockImplementation(() => undefined);
                                               
  mockPlatform.fs.stat.mockReset().mockResolvedValue({
    size: 1024,
    isFile: true,
    isDirectory: false,
    mtime: 0,
  });
  mockPlatform.fs.readTextFile.mockReset().mockResolvedValue('');
  mockPlatform.agentCapabilities.discover.mockReset().mockResolvedValue({ snapshotId: 'native-context', controls: [] });
  mockPlatform.agentCapabilities.listManaged.mockReset().mockResolvedValue({
    commands: [],
    skills: [],
    memory: [],
  });
});

describe('read_file tool', () => {
  const portable: AgentManagedSkill = { id: 'bound', name: 'primer-review', description: 'Synthetic primer review', instructions: 'Synthetic body', provider: 'all', scope: 'global', workspacePath: null, directoryPath: '/private/skills/bound', enabled: true, hasSupportingFiles: false, origin: 'local', source: null, contentDigest: null, createdAt: 1, updatedAt: 1 };
  const native = (snapshotId = 'native-context', id = portable.id, version = 1) => ({ snapshotId, controls: [{ source: `dnaforge-skill:${id}`, sourceVersion: String(version), availability: { state: 'supported' }, stages: { invocable: true } }] });
  const context = { provider: 'codex-sdk' as const, snapshotId: 'native-context' };

  it('keeps the scientific sequence read boundary for a selection-bearing supporting-file locator', async () => {
    const result = await execTool<{ error: string }>(createReadFileTool(singleFolder), { path: managedSkillLocator(portable, context, 'references/sequence.fasta') });
    expect(result.error).toMatch(/get_sequence.*documentId/i);
    expect(mockPlatform.fs.readAdmittedTextFile).not.toHaveBeenCalled(); expect(mockPlatform.agentCapabilities.discover).not.toHaveBeenCalled();
  });

  it('refuses a bound global locator below a disabled workspace winner before filesystem admission', async () => {
    mockPlatform.agentCapabilities.discover.mockResolvedValue(native());
    mockPlatform.agentCapabilities.listManaged.mockResolvedValue({ skills: [portable, { ...portable, id: 'disabled', scope: 'workspace', workspacePath: WORKSPACE, enabled: false }] });
    await expect(execTool(createReadFileTool(singleFolder), { path: managedSkillLocator(portable, context) })).rejects.toThrow(/not available or is disabled/i);
    expect(mockPlatform.fs.readAdmittedTextFile).not.toHaveBeenCalled();
  });

  it('loads only the bound actual folder while a different folder disables its inherited global skill', async () => {
    const folders = [{ name: 'a', path: '/a', addedAt: 1 }, { name: 'b', path: '/b', addedAt: 2 }];
    mockPlatform.agentCapabilities.discover.mockImplementation(async ({ workspacePath }) => native(workspacePath === '/a' ? 'context-a' : 'context-b'));
    mockPlatform.agentCapabilities.listManaged.mockResolvedValue({ skills: [portable] });
    mockPlatform.fs.readTextFile.mockResolvedValue('Synthetic bound body');
    const result = await execTool<{ sequence: string }>(createReadFileTool(folders), { path: managedSkillLocator(portable, { ...context, snapshotId: 'context-b' }) });
    expect(result.sequence).toBe('Synthetic bound body');
    expect(mockPlatform.agentCapabilities.listManaged).toHaveBeenCalledWith({ workspacePath: '/b', conversationId: null });
    expect(mockPlatform.agentCapabilities.listManaged).not.toHaveBeenCalledWith({ workspacePath: '/a', conversationId: null });
    expect(mockPlatform.fs.readAdmittedTextFile).toHaveBeenCalledWith({ path: '/private/skills/bound/SKILL.md', projectRoots: ['/a', '/b'], grantedFiles: ['/private/skills/bound/SKILL.md'] });
  });

  it('rejects an old context or revision instead of loading a same-named replacement after restart', async () => {
    mockPlatform.agentCapabilities.discover.mockResolvedValue(native('restarted-context', 'new', 2));
    mockPlatform.agentCapabilities.listManaged.mockResolvedValue({ skills: [{ ...portable, id: 'new', updatedAt: 2, directoryPath: '/private/skills/new' }] });
    await expect(execTool(createReadFileTool(singleFolder), { path: managedSkillLocator(portable, context) })).rejects.toThrow(/not available or is disabled/i);
    await expect(execTool(createReadFileTool(singleFolder), { path: managedSkillLocator(portable, { ...context, snapshotId: 'restarted-context' }) })).rejects.toThrow(/not available or is disabled/i);
    expect(mockPlatform.fs.readAdmittedTextFile).not.toHaveBeenCalled();
    mockPlatform.fs.readTextFile.mockResolvedValue('New exact revision');
    expect(await execTool(createReadFileTool(singleFolder), { path: managedSkillLocator({ ...portable, id: 'new', updatedAt: 2 }, { ...context, snapshotId: 'restarted-context' }) })).toMatchObject({ sequence: 'New exact revision' });
  });

  it('retires a selected locator when native context changes during the inventory await', async () => {
    let resolve!: (value: { skills: AgentManagedSkill[] }) => void;
    const pending = new Promise<{ skills: AgentManagedSkill[] }>((yes) => { resolve = yes; });
    let entered!: () => void; const called = new Promise<void>((yes) => { entered = yes; });
    mockPlatform.agentCapabilities.discover.mockResolvedValueOnce(native()).mockResolvedValue(native('changed-context'));
    mockPlatform.agentCapabilities.listManaged.mockImplementationOnce(() => { entered(); return pending; });
    const read = execTool(createReadFileTool(singleFolder), { path: managedSkillLocator(portable, context) }); await called;
    resolve({ skills: [portable] }); await expect(read).rejects.toThrow(/not available or is disabled/i);
    expect(mockPlatform.fs.readAdmittedTextFile).not.toHaveBeenCalled();
  });

  it('does not tell agents to list the workspace before reading an advertised skill path', () => {
    const description = createReadFileTool(singleFolder).description ?? '';

    expect(description).toContain('exact skill:// locator returned by search_skills');
    expect(description).toContain('Do not call list_files for a skill locator');
    expect(description).toContain('For project files whose path is unknown, use list_files first');
  });

  it('directs GenBank sequence reads to get_sequence without touching the filesystem', async () => {
    const tool = createReadFileTool(singleFolder);
    const result = await execTool<{ error: string }>(tool, { path: 'test.gb' });

    expect(result.error).toMatch(/get_sequence.*documentId/i);
    expect(mockPlatform.fs.stat).not.toHaveBeenCalled();
    expect(mockPlatform.fs.readTextFile).not.toHaveBeenCalled();
    expect(mockPlatform.fs.readAdmittedTextFile).not.toHaveBeenCalled();
  });

  it('directs FASTA sequence reads to get_sequence without touching the filesystem', async () => {
    const tool = createReadFileTool(singleFolder);
    const result = await execTool<{ error: string }>(tool, {
      path: 'seq.fasta',
    });

    expect(result.error).toMatch(/get_sequence.*documentId/i);
    expect(mockPlatform.fs.stat).not.toHaveBeenCalled();
    expect(mockPlatform.fs.readTextFile).not.toHaveBeenCalled();
    expect(mockPlatform.fs.readAdmittedTextFile).not.toHaveBeenCalled();
  });

  it('rejects sequence paths before generic-file projection limits are considered', async () => {
    const tool = createReadFileTool(singleFolder);
    const result = await execTool<{ error: string }>(tool, { path: 'bounded.gb' });

    expect(result.error).toMatch(/physical sequence paths are deprecated/i);
    expect(mockPlatform.fs.stat).not.toHaveBeenCalled();
    expect(mockPlatform.fs.readAdmittedTextFile).not.toHaveBeenCalled();
  });

  it('returns plain text for non-biology files', async () => {
    const longText = 'This is a notebook entry. '.repeat(1000);
    mockPlatform.fs.readTextFile.mockResolvedValueOnce(longText);

    const tool = createReadFileTool(singleFolder);
    const result = await execTool<{ format: string; sequence: string }>(tool, {
      path: 'notes.txt',
    });

    expect(result.format).toBe('text');
    expect(result.sequence.length).toBe(10000);             
  });

  it('resolves relative paths to workspace', async () => {
    mockPlatform.fs.readTextFile.mockResolvedValueOnce('text');

    const tool = createReadFileTool(singleFolder);
    await execTool(tool, { path: 'data/notes.txt' });

    expect(mockPlatform.fs.readAdmittedTextFile).toHaveBeenCalledWith({
      path: `${WORKSPACE}/data/notes.txt`,
      projectRoots: [WORKSPACE],
      grantedFiles: [],
    });
  });

  it('rejects absolute paths', async () => {
    const tool = createReadFileTool(singleFolder);
    await expect(execTool(tool, { path: '/etc/passwd' })).rejects.toThrow(/absolute/i);
    await expect(execTool(tool, { path: 'C:\\Windows\\System32' })).rejects.toThrow(/absolute/i);
  });

  it('reads an enabled global portable skill through the app bridge without a mounted workspace', async () => {
    const skillRoot = '/home/user/.dnaforge/skills/skill-1';
    const skillPath = `${skillRoot}/SKILL.md`;
    mockPlatform.agentCapabilities.listManaged.mockResolvedValueOnce({
      commands: [],
      memory: [],
      skills: [
        {
          id: 'skill-1',
          name: 'primer-review',
          description: 'Review primers.',
          instructions: 'Apply the primer checklist.',
          provider: 'all',
          scope: 'global',
          workspacePath: null,
          directoryPath: skillRoot,
          enabled: true,
          hasSupportingFiles: false,
          origin: 'local',
          source: null,
          contentDigest: null,
          createdAt: 1,
          updatedAt: 1,
        },
      ],
    });
    mockPlatform.fs.readTextFile.mockResolvedValueOnce('Apply the primer checklist.');

    const result = await execTool<{ path: string; format: string; sequence: string }>(
      createReadFileTool([]),
      { path: skillPath }
    );

    expect(mockPlatform.agentCapabilities.listManaged).toHaveBeenCalledWith({
      workspacePath: null,
      conversationId: null,
    });
    expect(mockPlatform.fs.readAdmittedTextFile).toHaveBeenCalledWith({
      path: skillPath,
      projectRoots: [],
      grantedFiles: [skillPath],
    });
    expect(mockPlatform.fs.readTextFile).toHaveBeenCalledWith(skillPath);
    expect(result).toMatchObject({
      path: 'primer-review/SKILL.md',
      format: 'text',
      sequence: 'Apply the primer checklist.',
    });
  });

  it('resolves a stable portable-skill locator without exposing or copying its opaque directory id', async () => {
    const skillRoot = '/home/user/.dnaforge/skills/e41968d0-9a52-4476-921d-027a6d0328c7';
    mockPlatform.agentCapabilities.listManaged.mockResolvedValue({
      commands: [],
      memory: [],
      skills: [
        {
          id: 'e41968d0-9a52-4476-921d-027a6d0328c7',
          name: 'parabad-backbone-design',
          description: 'Design pARABAD backbones.',
          instructions: 'Apply the pARABAD checklist.',
          provider: 'all',
          scope: 'global',
          workspacePath: null,
          directoryPath: skillRoot,
          enabled: true,
          hasSupportingFiles: true,
          origin: 'local',
          source: null,
          contentDigest: null,
          createdAt: 1,
          updatedAt: 1,
        },
      ],
    });
    mockPlatform.fs.readTextFile.mockResolvedValueOnce('Apply the pARABAD checklist.');

    const result = await execTool<{ path: string; sequence: string }>(
      createReadFileTool(singleFolder),
      {
        path: 'skill://parabad-backbone-design/SKILL.md',
      }
    );

    expect(mockPlatform.fs.readAdmittedTextFile).toHaveBeenCalledWith({
      path: `${skillRoot}/SKILL.md`,
      projectRoots: [WORKSPACE],
      grantedFiles: [`${skillRoot}/SKILL.md`],
    });
    expect(mockPlatform.fs.readTextFile).toHaveBeenCalledWith(`${skillRoot}/SKILL.md`);
    expect(result).toMatchObject({
      path: 'parabad-backbone-design/SKILL.md',
      sequence: 'Apply the pARABAD checklist.',
    });
  });

  it('uses the host-qualified locator when same-named skills belong to different hosts', async () => {
    const baseSkill = {
      name: 'sequence-audit',
      description: 'Audit sequences.',
      instructions: 'Apply the checklist.',
      scope: 'global' as const,
      workspacePath: null,
      enabled: true,
      hasSupportingFiles: false,
      origin: 'local' as const,
      source: null,
      contentDigest: null,
      createdAt: 1,
      updatedAt: 1,
    };
    mockPlatform.agentCapabilities.listManaged.mockResolvedValue({
      commands: [],
      memory: [],
      skills: [
        {
          ...baseSkill,
          id: 'codex-skill',
          provider: 'codex-sdk',
          directoryPath: '/home/user/.dnaforge/skills/codex-skill',
        },
        {
          ...baseSkill,
          id: 'claude-skill',
          provider: 'claude-agent-sdk',
          directoryPath: '/home/user/.dnaforge/skills/claude-skill',
        },
      ],
    });
    mockPlatform.fs.readTextFile.mockResolvedValueOnce('Codex instructions.');

    await execTool(createReadFileTool(singleFolder), {
      path: 'skill://codex-sdk/sequence-audit/SKILL.md',
    });

    expect(mockPlatform.fs.readTextFile).toHaveBeenCalledWith(
      '/home/user/.dnaforge/skills/codex-skill/SKILL.md'
    );
  });

  it('refuses traversal and disabled targets through a portable-skill locator', async () => {
    const skillRoot = '/home/user/.dnaforge/skills/skill-1';
    mockPlatform.agentCapabilities.listManaged.mockResolvedValue({
      commands: [],
      memory: [],
      skills: [
        {
          id: 'skill-1',
          name: 'primer-review',
          description: 'Review primers.',
          instructions: 'Apply the primer checklist.',
          provider: 'all',
          scope: 'global',
          workspacePath: null,
          directoryPath: skillRoot,
          enabled: false,
          hasSupportingFiles: true,
          origin: 'local',
          source: null,
          contentDigest: null,
          createdAt: 1,
          updatedAt: 1,
        },
      ],
    });

    await expect(
      execTool(createReadFileTool([]), { path: 'skill://primer-review/../secrets.txt' })
    ).rejects.toThrow(/invalid portable skill locator/i);
    await expect(
      execTool(createReadFileTool([]), { path: 'skill://primer-review/SKILL.md' })
    ).rejects.toThrow(/not available or is disabled/i);
    expect(mockPlatform.fs.readAdmittedTextFile).not.toHaveBeenCalled();
    expect(mockPlatform.fs.readTextFile).not.toHaveBeenCalled();
  });

  it('retries one transient managed-skill lookup before refusing an app-owned path', async () => {
    const skillRoot = '/home/user/.dnaforge/skills/skill-1';
    const skillPath = `${skillRoot}/SKILL.md`;
    mockPlatform.agentCapabilities.listManaged
      .mockRejectedValueOnce(new Error('transient IPC failure'))
      .mockResolvedValueOnce({
        commands: [],
        memory: [],
        skills: [
          {
            id: 'skill-1',
            name: 'primer-review',
            description: 'Review primers.',
            instructions: 'Apply the primer checklist.',
            provider: 'all',
            scope: 'global',
            workspacePath: null,
            directoryPath: skillRoot,
            enabled: true,
            hasSupportingFiles: false,
            origin: 'local',
            source: null,
            contentDigest: null,
            createdAt: 1,
            updatedAt: 1,
          },
        ],
      });
    mockPlatform.fs.readTextFile.mockResolvedValueOnce('Apply the primer checklist.');

    const result = await execTool<{ sequence: string }>(createReadFileTool([]), {
      path: skillPath,
    });

    expect(mockPlatform.agentCapabilities.listManaged).toHaveBeenCalledTimes(2);
    expect(result.sequence).toBe('Apply the primer checklist.');
  });

  it('refuses a separate global fallback when the applicable workspace policy is unknown', async () => {
    const skillRoot = '/home/user/.dnaforge/skills/skill-1';
    const skillPath = `${skillRoot}/SKILL.md`;
    mockPlatform.agentCapabilities.listManaged.mockImplementation(async ({ workspacePath }) => {
      if (workspacePath !== null) throw new Error('workspace authorization is not ready');
      return {
        commands: [],
        memory: [],
        skills: [
          {
            id: 'skill-1',
            name: 'primer-review',
            description: 'Review primers.',
            instructions: 'Apply the primer checklist.',
            provider: 'all',
            scope: 'global',
            workspacePath: null,
            directoryPath: skillRoot,
            enabled: true,
            hasSupportingFiles: false,
            origin: 'local',
            source: null,
            contentDigest: null,
            createdAt: 1,
            updatedAt: 1,
          },
        ],
      };
    });
    mockPlatform.fs.readTextFile.mockResolvedValueOnce('Apply the primer checklist.');

    await expect(execTool(createReadFileTool(singleFolder), { path: skillPath })).rejects.toThrow(/absolute/i);
    expect(mockPlatform.agentCapabilities.listManaged).toHaveBeenCalledWith({ workspacePath: WORKSPACE, conversationId: null });
    expect(mockPlatform.agentCapabilities.listManaged).not.toHaveBeenCalledWith({ workspacePath: null, conversationId: null });
    expect(mockPlatform.fs.readAdmittedTextFile).not.toHaveBeenCalled();
  });

  it('does not widen absolute-path reads for a disabled portable skill', async () => {
    const skillRoot = '/home/user/.dnaforge/skills/skill-1';
    mockPlatform.agentCapabilities.listManaged.mockResolvedValueOnce({
      commands: [],
      memory: [],
      skills: [
        {
          id: 'skill-1',
          name: 'primer-review',
          description: 'Review primers.',
          instructions: 'Apply the primer checklist.',
          provider: 'all',
          scope: 'global',
          workspacePath: null,
          directoryPath: skillRoot,
          enabled: false,
          hasSupportingFiles: false,
          origin: 'local',
          source: null,
          contentDigest: null,
          createdAt: 1,
          updatedAt: 1,
        },
      ],
    });

    await expect(
      execTool(createReadFileTool(singleFolder), { path: `${skillRoot}/SKILL.md` })
    ).rejects.toThrow(/absolute/i);
    expect(mockPlatform.fs.readTextFile).not.toHaveBeenCalled();
  });

  it('signals truncation for large text files', async () => {
    mockPlatform.fs.readTextFile.mockResolvedValueOnce('Long notebook line 123. '.repeat(1000));

    const tool = createReadFileTool(singleFolder);
    const result = await execTool<{ truncated: boolean }>(tool, { path: 'big.txt' });

    expect(result.truncated).toBe(true);
  });

  it('does not signal truncation for small text files', async () => {
    mockPlatform.fs.readTextFile.mockResolvedValueOnce('small content');

    const tool = createReadFileTool(singleFolder);
    const result = await execTool<{ truncated: boolean }>(tool, { path: 'small.txt' });

    expect(result.truncated).toBe(false);
  });

  it('rejects path traversal attempts', async () => {
    const tool = createReadFileTool(singleFolder);
    await expect(execTool(tool, { path: '../../etc/passwd' })).rejects.toThrow(/project boundary/i);
  });

  it('rejects normalized path traversal (e.g. foo/../../etc)', async () => {
    const tool = createReadFileTool(singleFolder);
    await expect(execTool(tool, { path: 'foo/../../etc/passwd' })).rejects.toThrow(
      /project boundary/i
    );
  });

  it('rejects files past the SHARED ceiling, without reading them', async () => {
    mockPlatform.fs.readAdmittedTextFile.mockRejectedValueOnce(
      Object.assign(new Error('File too large (314572800 bytes, above hard cap): huge.txt'), {
        name: 'OversizedFileError',
        sizeBytes: 300 * 1024 * 1024,
        path: 'huge.txt',
        hardCap: true,
      })
    );

    const tool = createReadFileTool(singleFolder);
    await expect(execTool(tool, { path: 'huge.txt' })).rejects.toThrow(/too large/i);

    expect(mockPlatform.fs.readTextFile).not.toHaveBeenCalled();
  });

  it('reads a generic project file below the shared size ceiling', async () => {
    mockPlatform.fs.stat.mockResolvedValueOnce({
      size: 12 * 1024 * 1024,
      isFile: true,
      isDirectory: false,
      mtime: 0,
    });
    mockPlatform.fs.readTextFile.mockResolvedValueOnce('Large notebook export 123.');

    const tool = createReadFileTool(singleFolder);
    const result = await execTool<{ format?: string; error?: string }>(tool, {
      path: 'export.txt',
    });

    expect(result.error).toBeUndefined();
    expect(result.format).toBe('text');
    expect(mockPlatform.fs.readAdmittedTextFile).toHaveBeenCalled();
  });

  it('handles file not found', async () => {
    mockPlatform.fs.readTextFile.mockRejectedValueOnce(new Error('File not found'));

    const tool = createReadFileTool(singleFolder);
    await expect(execTool(tool, { path: 'nonexistent.txt' })).rejects.toThrow('File not found');
  });
});

describe('read_file tool (multi-folder)', () => {
  const multiFolders: WorkspaceFolder[] = [
    { name: 'Lab Data', path: '/home/user/lab', addedAt: 1 },
    { name: 'Shared', path: '/shared/plasmids', addedAt: 2 },
  ];

  it('resolves path with folder prefix', async () => {
    mockPlatform.fs.readTextFile.mockResolvedValueOnce('Project notes 123.');

    const tool = createReadFileTool(multiFolders);
    const result = await execTool<{ path: string; folder: string }>(tool, {
      path: 'Shared/protocol.txt',
    });

    expect(mockPlatform.fs.readTextFile).toHaveBeenCalledWith('/shared/plasmids/protocol.txt');
    expect(result.folder).toBe('Shared');
    expect(result.path).toBe('Shared/protocol.txt');
  });

  it('normalizes a known absolute workspace path and reports the stable folder-prefixed path', async () => {
    mockPlatform.fs.readTextFile.mockResolvedValueOnce('CRISPR notes 123.');

    const tool = createReadFileTool(multiFolders);
    const result = await execTool<{ path: string; folder: string }>(tool, {
      path: '/shared/plasmids/crispr/pSpCas9.txt',
    });

    expect(mockPlatform.fs.readTextFile).toHaveBeenCalledWith(
      '/shared/plasmids/crispr/pSpCas9.txt'
    );
    expect(result.folder).toBe('Shared');
    expect(result.path).toBe('Shared/crispr/pSpCas9.txt');
  });

  it('throws for ambiguous path with multiple folders', async () => {
    const tool = createReadFileTool(multiFolders);
    await expect(execTool(tool, { path: 'unknown.txt' })).rejects.toThrow(/could not determine/i);
  });
});

                                                                                
                                                                               
                                                            
describe('read_file tool — open-tab fallback', () => {
  const OUTSIDE = '/tmp/outside/notes.txt';

  beforeEach(() => {
    resetCanvasStore();
  });

  afterEach(() => {
    resetCanvasStore();
  });

  it('reads an open-tab file directly when no workspace is mounted', async () => {
    mockPlatform.fs.readTextFile.mockResolvedValueOnce('Outside notes 123.');
    useCanvasStore
      .getState()
      .openTab('main', { type: 'file', entityId: OUTSIDE, label: 'notes.txt' });

    const tool = createReadFileTool([]);
    const result = await execTool<{
      format: string;
      name: string;
      path: string;
      folder: string;
    }>(tool, { path: OUTSIDE });

    expect(mockPlatform.fs.readTextFile).toHaveBeenCalledWith(OUTSIDE);
    expect(result.format).toBe('text');
    expect(result.name).toBe('notes.txt');
    expect(result.path).toBe(OUTSIDE);
    expect(result.folder).toBe('');
  });

  it('reads an open-tab file whose path is outside the mounted workspace', async () => {
    mockPlatform.fs.readTextFile.mockResolvedValueOnce('Outside notes 123.');
    useCanvasStore
      .getState()
      .openTab('main', { type: 'file', entityId: OUTSIDE, label: 'test.gb' });

                                                            
    const tool = createReadFileTool(singleFolder);
    const result = await execTool<{ format: string; path: string }>(tool, {
      path: OUTSIDE,
    });

    expect(mockPlatform.fs.readTextFile).toHaveBeenCalledWith(OUTSIDE);
    expect(result.format).toBe('text');
    expect(result.path).toBe(OUTSIDE);
  });

  it('returns the NO_WORKSPACE message for an unopened path with no workspace', async () => {
    const tool = createReadFileTool([]);
    const result = await execTool<{ error: string }>(tool, { path: '/tmp/not-open.txt' });

    expect(result.error).toBe(NO_WORKSPACE_TOOL_MESSAGE);
    expect(mockPlatform.fs.readTextFile).not.toHaveBeenCalled();
  });
});

import { readFileOutputSchema } from './read-file';

async function execTool<T>(...args: Parameters<typeof executeTool>): Promise<T> {
  const result = await executeTool<T>(...args);
  if (result && typeof result === 'object' && 'ok' in result && result.ok === true) {
    assertMcpOutput(readFileOutputSchema, result);
  }
  return result;
}

describe('read_file Skills authoritative observation', () => {
  const selected: AgentManagedSkill = { id: 'private-bound-native', name: 'synthetic-private-audit', description: 'Synthetic acceptance only.', instructions: 'PRIVATE SYNTHETIC INSTRUCTION BODY', provider: 'all', scope: 'global', workspacePath: null, directoryPath: '/private/synthetic-skills/bound', enabled: true, hasSupportingFiles: true, origin: 'local', source: null, contentDigest: null, createdAt: 10, updatedAt: 20 };
  const context = { provider: 'codex-sdk' as const, snapshotId: 'private-native-context' };
  function admit() {
    mockPlatform.agentCapabilities.discover.mockResolvedValue({ snapshotId: context.snapshotId, capturedAt: 30, controls: [{ source: `dnaforge-skill:${selected.id}`, sourceVersion: '20', availability: { state: 'supported' }, stages: { invocable: true } }] });
    mockPlatform.agentCapabilities.listManaged.mockResolvedValue({ skills: [selected] });
  }
  function observations() { return skillCapture.capture.mock.calls.filter(([event]) => event === 'skill_operation_observed').map(([, properties]) => properties); }
  it('observes an actual approved full instruction read without attributing useful task completion', async () => {
    admit(); mockPlatform.fs.readTextFile.mockResolvedValue(selected.instructions);
    const result = await execTool<{ sequence: string }>(createReadFileTool(singleFolder), { path: managedSkillLocator(selected, context) });
    expect(result.sequence).toBe(selected.instructions);
    expect(observations()).toEqual(expect.arrayContaining([expect.objectContaining({ skills_stage: 'instruction', skills_result: 'instruction_returned', skills_instruction_load: 'full', skills_authority: 'approved_locator_read', skills_freshness: 'approved_at_admission', skills_host: 'codex-sdk', skills_scope: 'global', skills_task_reuse: 'not_attested', skills_observed_at_ms: 30 })]));
    expect(JSON.stringify(observations())).not.toMatch(/private-|PRIVATE|synthetic-private-audit|skill:\/\/|SKILL\.md/u);
  });
  it('reports actual returned truncation and supporting-file reads as separate bounded facets', async () => {
    admit(); mockPlatform.fs.readTextFile.mockResolvedValue('Z'.repeat(10_001));
    const text = await execTool<{ truncated: boolean; sequence: string }>(createReadFileTool(singleFolder), { path: managedSkillLocator(selected, context) });
    expect(text).toMatchObject({ truncated: true }); expect(text.sequence).toHaveLength(10_000);
    expect(observations().at(-1)).toMatchObject({ skills_instruction_load: 'truncated', skills_task_reuse: 'not_attested' });
    mockPlatform.fs.readTextFile.mockResolvedValue('CONTROLLED SUPPORTING TEXT');
    await execTool(createReadFileTool(singleFolder), { path: managedSkillLocator(selected, context, 'references/check.md') });
    expect(observations().at(-1)).toMatchObject({ skills_result: 'supporting_file_returned', skills_instruction_load: 'supporting_file', skills_task_reuse: 'not_attested' });
  });
  it('refuses a disabled workspace winner before filesystem access and cannot claim loading or reuse', async () => {
    admit(); mockPlatform.agentCapabilities.listManaged.mockResolvedValue({ skills: [selected, { ...selected, id: 'private-disabled', scope: 'workspace', workspacePath: WORKSPACE, enabled: false }] });
    await expect(execTool(createReadFileTool(singleFolder), { path: managedSkillLocator(selected, context) })).rejects.toThrow(/not available or is disabled/i);
    expect(mockPlatform.fs.readAdmittedTextFile).not.toHaveBeenCalled();
    expect(observations().at(-1)).toMatchObject({ skills_result: 'instruction_refused', skills_instruction_load: 'refused', skills_task_reuse: 'not_attested' });
  });
  it.each(['consent_off', 'publisher_throws'])('preserves the real approved read when %s', async (failure) => {
    admit(); mockPlatform.fs.readTextFile.mockResolvedValue(selected.instructions);
    if (failure === 'consent_off') skillCapture.ready = false; else skillCapture.capture.mockImplementation(() => { throw new Error('Synthetic optional publisher unavailable'); });
    const result = await execTool<{ sequence: string }>(createReadFileTool(singleFolder), { path: managedSkillLocator(selected, context) });
    expect(result.sequence).toBe(selected.instructions); expect(mockPlatform.fs.readAdmittedTextFile).toHaveBeenCalledOnce();
    if (failure === 'consent_off') expect(skillCapture.capture).not.toHaveBeenCalled();
  });
});
