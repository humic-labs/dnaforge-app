import { beginSkillObservation } from '../../../lib/skill-operation-telemetry';
import type { SkillObservationContext } from '../../../shared/skill-operation-telemetry';
import { selectManagedSkills } from '../../../shared/agent-capability-controls';
import type { AgentTransport } from '../../../shared/agent-runtime-ipc';
   
                                                
   

import { resultTool, toolSuccess, toolFailure } from '../../agent-bridge/public/tool-result';
import { z } from 'zod';
import { platform } from '../../../platform';
import type {
  AgentManagedProvider,
  AgentManagedSkill,
} from '../../../shared/agent-capability-controls';
import type { WorkspaceFolder } from '../../../stores/workspaceStore';
import {
  resolveMultiRootPath,
  getUserFolders,
  hasNoUserWorkspace,
  NO_WORKSPACE_TOOL_MESSAGE,
  normalizePath,
  resolveOpenTabAbsolutePath,
} from './path-utils';
import {
  isAbsolutePathLike,
  isPathInsideBoundary,
  isSafeWorkspaceRelativePath,
  pathRelativeToBoundary,
} from '../../../shared/path-boundary';
import { parseBiologyContent } from './parse-biology-file';
import { HARD_CAP_BYTES, isOversizedFileError } from '../../../shared/oversized-guard';
import { isSupportedSequencePath } from '../../../shared/scientific-file-types';

const MAX_TEXT_LENGTH = 10_000;
const MAX_INLINE_SEQUENCE_BP = 50_000;
const MAX_ANNOTATIONS = 100;
const PORTABLE_SKILL_LOCATOR_PREFIX = 'skill://';
const PORTABLE_SKILL_NAME = /^[a-z0-9][a-z0-9-]{0,63}$/u;
const PORTABLE_SKILL_PROVIDERS = new Set<AgentManagedProvider>([
  'all',
  'codex-sdk',
  'claude-agent-sdk',
  'grok-acp',
]);

export const READ_FILE_DESCRIPTION =
  'Read a generic project file or an already-open file tab. Sequence documents are excluded; ' +
  'use get_sequence with their stable document ID instead. ' +
  'An enabled portable DNAForge skill may be read from the exact skill:// locator returned by search_skills, even without a project. ' +
  'Do not call list_files for a skill locator. For project files whose path is unknown, use list_files first.';

const textReadResult = z.object({
  ok: z.literal(true),
  path: z.string(),
  folder: z.string(),
  format: z.literal('text'),
  name: z.string(),
  length: z.number().int().nonnegative(),
  sequence: z.string(),
  truncated: z.boolean(),
});
const biologyReadResult = z.object({
  ok: z.literal(true),
  path: z.string(),
  folder: z.string(),
  format: z.string(),
  name: z.string(),
  length: z.number().int().nonnegative(),
  circular: z.boolean(),
  sequenceIncluded: z.boolean(),
  sequence: z.string().nullable(),
  sequencePreview: z.string().nullable(),
  annotationCount: z.number().int().nonnegative(),
  annotationsTruncated: z.boolean(),
  annotations: z.array(
    z.object({
      name: z.string(),
      type: z.string(),
      start: z.number(),
      end: z.number(),
      direction: z.enum(['forward', 'reverse', 'none']),
    })
  ),
  description: z.string().optional(),
});
export const readFileOutputSchema = z.union([textReadResult, biologyReadResult]);

export const readFileSchema = z.object({ path: z.string() }).strict();

function parsePortableSkillLocator(path: string): {
  provider: AgentManagedProvider | null;
  name: string;
  relativePath: string;
  selection: { provider: AgentTransport; snapshotId: string; updatedAt: number } | null;
} | null {
  if (!path.startsWith(PORTABLE_SKILL_LOCATOR_PREFIX)) return null;
  const [locator, query, extra] = path.slice(PORTABLE_SKILL_LOCATOR_PREFIX.length).split('?');
  if (extra !== undefined) return null;
  const segments = locator.split('/');
  const provider = PORTABLE_SKILL_PROVIDERS.has(segments[0] as AgentManagedProvider)
    ? (segments.shift() as AgentManagedProvider)
    : null;
  const name = segments.shift() ?? '';
  const relativePath = segments.join('/');
  if (!PORTABLE_SKILL_NAME.test(name) || !isSafeWorkspaceRelativePath(relativePath)) return null;
  let selection: { provider: AgentTransport; snapshotId: string; updatedAt: number } | null = null;
  if (query !== undefined) {
    const fields = new URLSearchParams(query);
    const host = fields.get('host'); const snapshotId = fields.get('snapshot'); const updated = fields.get('updated');
    if ([...fields.keys()].length !== 3 || !['codex-sdk', 'claude-agent-sdk', 'grok-acp'].includes(host ?? '') ||
      !snapshotId || snapshotId.length > 200 || !updated || !/^\d+$/u.test(updated) || !Number.isSafeInteger(Number(updated))) return null;
    if ([...fields.keys()].some((key) => !['host', 'snapshot', 'updated'].includes(key))) return null;
    selection = { provider: host as AgentTransport, snapshotId, updatedAt: Number(updated) };
  }
  return { provider, name, relativePath, selection };
}

async function resolveEnabledPortableSkillPath(
  folders: WorkspaceFolder[],
  path: string
): Promise<{ absolutePath: string; displayPath: string; observation: SkillObservationContext; primaryInstruction: boolean } | null> {
  const locator = parsePortableSkillLocator(path);
  if (!locator && !isAbsolutePathLike(path)) return null;
  const absolutePath = locator ? null : normalizePath(path);
  const workspacePaths = getUserFolders(folders).map((folder) => folder.path);
  const contexts: Array<string | null> = workspacePaths.length ? [...new Set(workspacePaths)] : [null];
  const providers = ['codex-sdk', 'claude-agent-sdk', 'grok-acp'] as const;
  for (let lookupAttempt = 0; lookupAttempt < 2; lookupAttempt += 1) {
    if (locator?.selection) {
      const selected = locator.selection;
      for (const workspacePath of contexts) {
        try {
          const snapshot = await platform().agentCapabilities.discover({ provider: selected.provider, workspacePath, conversationId: null });
          if (snapshot.snapshotId !== selected.snapshotId) continue;
          const managed = await platform().agentCapabilities.listManaged({ workspacePath, conversationId: null });
          const skill = selectManagedSkills(managed.skills, selected.provider, workspacePath).find((candidate) =>
            candidate.name === locator.name && candidate.enabled && candidate.updatedAt === selected.updatedAt &&
            (locator.provider === null || candidate.provider === locator.provider));
          if (!skill) return null;


          const current = await platform().agentCapabilities.discover({ provider: selected.provider, workspacePath, conversationId: null });
          if (current.snapshotId !== selected.snapshotId) return null;
          const skillRoot = normalizePath(skill.directoryPath);
          const resolvedPath = normalizePath(`${skillRoot}/${locator.relativePath}`);
          if (!isPathInsideBoundary(resolvedPath, skillRoot)) return null;
          return { absolutePath: resolvedPath, displayPath: `${skill.name}/${locator.relativePath}`, observation: { host: selected.provider, scope: skill.scope, source: skill.origin, authority: 'approved_locator_read', freshness: 'approved_at_admission', observedAtMs: current.capturedAt }, primaryInstruction: locator.relativePath.toLowerCase() === 'skill.md' };
        } catch {                                                                   }
      }
      continue;
    }


    const candidates: AgentManagedSkill[] = []; let complete = true;
    for (const workspacePath of contexts) {
      let managed;
      try { managed = await platform().agentCapabilities.listManaged({ workspacePath, conversationId: null }); }
      catch { complete = false; break; }
      const hosts = locator?.provider && locator.provider !== 'all' ? [locator.provider] : providers;
      for (const host of hosts) {
        const effective = selectManagedSkills(managed.skills, host, workspacePath);
        const skill = effective.find((candidate) => locator ? candidate.name === locator.name :
          absolutePath !== null && isPathInsideBoundary(absolutePath, normalizePath(candidate.directoryPath)));
        if (!skill?.enabled || (locator?.provider && skill.provider !== locator.provider)) { complete = false; break; }
        candidates.push(skill);
      }
      if (!complete) break;
    }
    const skill = candidates[0];
    if (!complete || !skill || !candidates.every((candidate) => candidate.id === skill.id && candidate.updatedAt === skill.updatedAt)) continue;
    const skillRoot = normalizePath(skill.directoryPath);
    const resolvedPath = locator ? normalizePath(`${skillRoot}/${locator.relativePath}`) : absolutePath;
    if (!resolvedPath || !isPathInsideBoundary(resolvedPath, skillRoot)) return null;
    const relativePath = pathRelativeToBoundary(resolvedPath, skillRoot); if (!relativePath) return null;
    return { absolutePath: resolvedPath, displayPath: `${skill.name}/${relativePath}`, observation: { host: skill.provider, scope: skill.scope, source: skill.origin, authority: 'compatibility_read', freshness: 'approved_at_admission' }, primaryInstruction: relativePath.toLowerCase() === 'skill.md' };
  }
  return null;
}

export function createReadFileTool(folders: WorkspaceFolder[]) {
  const inputSchema = z
    .object({
      path: z
        .string()
        .describe(
          folders.length > 1
            ? 'Path to the file, prefixed with folder name (e.g., "Lab Data/file.gb").'
            : 'Path to the file, relative to the project root.'
        ),
    })
    .strict();

  return resultTool({
    description:
      READ_FILE_DESCRIPTION +
      (folders.length > 1
        ? ' Prefix project paths with the project name (e.g., "Lab Data/notes/experiment.txt").'
        : ' Project paths must be relative to the project.'),
    inputSchema: inputSchema as z.ZodTypeAny,
    execute: async ({ path }: z.infer<typeof inputSchema>) => {
      let measurement = path.startsWith(PORTABLE_SKILL_LOCATOR_PREFIX)
        ? beginSkillObservation('instruction_load')
        : null;
      try {
        const scientificPath = path.startsWith(PORTABLE_SKILL_LOCATOR_PREFIX)
          ? parsePortableSkillLocator(path)?.relativePath ?? path
          : path;
        if (isSupportedSequencePath(scientificPath)) {
          measurement?.settle('instruction', 'instruction_refused', { instruction: 'refused' });
          return toolFailure({
            code: 'SEQUENCE_DOCUMENT_REQUIRED',
            retriable: false,
            stateChanged: false,
            partialEffects: [],
          error:
            'Physical sequence paths are deprecated. Use get_sequence with the stable sequence documentId.',
        });
      }
                                                                               
                                                                                
                                                                                
                                                                             
                                                                        
      const openTabAbsPath = await resolveOpenTabAbsolutePath(path);
      const portableSkillPath = await resolveEnabledPortableSkillPath(folders, path);
      if (portableSkillPath && !measurement) measurement = beginSkillObservation('instruction_load', portableSkillPath.observation);
      if (path.startsWith(PORTABLE_SKILL_LOCATOR_PREFIX) && !parsePortableSkillLocator(path)) {
        throw new Error('Invalid portable skill locator.');
      }
      if (path.startsWith(PORTABLE_SKILL_LOCATOR_PREFIX) && !portableSkillPath) {
        throw new Error('That portable skill is not available or is disabled.');
      }
      if (hasNoUserWorkspace(folders) && !openTabAbsPath && !portableSkillPath) {
        return toolFailure({
          code: 'NO_WORKSPACE',
          error: NO_WORKSPACE_TOOL_MESSAGE,
          retriable: false,
          stateChanged: false,
          partialEffects: [],
        });
      }

      let fullPath!: string;
      let displayPath!: string;
      let folderName!: string;

      let resolvedInWorkspace = false;
      if (!portableSkillPath && !hasNoUserWorkspace(folders)) {
        try {
          const resolved = resolveMultiRootPath(folders, path);
          fullPath = resolved.absolutePath;
          displayPath =
            folders.length > 1
              ? `${resolved.folder.name}/${resolved.relativePath}`
              : resolved.relativePath || path;
          folderName = resolved.folder.name;
          resolvedInWorkspace = true;
        } catch (err) {
          if (!openTabAbsPath && !portableSkillPath) throw err;
        }
      }
      if (!resolvedInWorkspace) {
        if (portableSkillPath) {
          fullPath = portableSkillPath.absolutePath;
          displayPath = portableSkillPath.displayPath;
          folderName = 'DNAForge skills';
        } else {
                                                                           
          fullPath = openTabAbsPath as string;
          displayPath = openTabAbsPath as string;
          folderName = '';
        }
      }

      let content: string;
      try {
        content = await platform().fs.readAdmittedTextFile({
          path: fullPath,
          projectRoots: getUserFolders(folders).map((folder) => folder.path),
          grantedFiles: [
            ...(openTabAbsPath ? [openTabAbsPath] : []),
            ...(portableSkillPath ? [portableSkillPath.absolutePath] : []),
          ],
        });
      } catch (err) {
        if (isOversizedFileError(err)) {
          const sizeBytes = err.sizeBytes;
          const mb =
            typeof sizeBytes === 'number' ? (sizeBytes / 1024 / 1024).toFixed(1) : 'unknown';
          const capMb = (HARD_CAP_BYTES / 1024 / 1024).toFixed(0);
          throw new Error(
            `File too large to read in full (${mb} MB, maximum ${capMb} MB) — the same limit a ` +
              `person hits. Use find_features for a targeted lookup instead of reading it whole.`
          );
        }
        throw err;
      }

      try {
        const parsedFile = parseBiologyContent(content, fullPath);
        const parsed = parsedFile.sequence;
        const sequence = parsed.sequence ?? '';
        const sequenceIncluded = sequence.length <= MAX_INLINE_SEQUENCE_BP;
        const annotations = parsedFile.features.slice(0, MAX_ANNOTATIONS).map((f) => ({
          name: f.displayName || f.type,
          type: f.type,
          start: f.start,
          end: f.end,
          direction: f.direction,
        }));
        const result = {
          path: displayPath,
          folder: folderName,
          format: parsedFile.format,
          name: parsed.name,
          length: parsed.length,
          circular: parsed.circular,
          sequenceIncluded,
          sequence: sequenceIncluded ? sequence : null,
          sequencePreview: sequenceIncluded ? null : sequence.slice(0, 1000),
          annotationCount: parsedFile.features.length,
          annotations,
          annotationsTruncated: parsedFile.features.length > annotations.length,
          description: parsed.description,
        };
        if (portableSkillPath) measurement?.settle('instruction', portableSkillPath.primaryInstruction ? 'instruction_returned' : 'supporting_file_returned', { ...portableSkillPath.observation, instruction: portableSkillPath.primaryInstruction ? 'full' : 'supporting_file' });
        return toolSuccess(result);
      } catch {
        const truncated = content.length > MAX_TEXT_LENGTH;
        const result = {
          path: displayPath,
          folder: folderName,
          format: 'text' as const,
          name: path.split('/').pop() || 'unknown',
          length: content.length,
          sequence: content.slice(0, MAX_TEXT_LENGTH),
          truncated,
        };
        if (portableSkillPath) measurement?.settle('instruction', portableSkillPath.primaryInstruction ? 'instruction_returned' : 'supporting_file_returned', { ...portableSkillPath.observation, instruction: portableSkillPath.primaryInstruction ? truncated ? 'truncated' : 'full' : 'supporting_file' });
        return toolSuccess(result);
      }
      } catch (error) {
        measurement?.settle('instruction', 'instruction_refused', { instruction: 'refused', authority: 'not_attested' });
        throw error;
      }
    },
  });
}
