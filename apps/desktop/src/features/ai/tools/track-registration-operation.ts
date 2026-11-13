import { z } from 'zod';

import { platform } from '../../../platform';
import { isPathInsideBoundary } from '../../../shared/path-boundary';
import { ASSEMBLY_ACCESSION_PATTERN, TRACK_SLUG_PATTERN } from '../../../shared/track-store';
import type { WorkspaceFolder } from '../../../stores/workspaceStore';
import { resultTool, toolFailure, toolSuccess } from '../../agent-bridge/public/tool-result';
import { getUserFolders, resolveMultiRootPath } from '../../workspace/public/path-resolve';

export const managedTrackRegistrationStartSchema = z
  .object({
    path: z
      .string()
      .min(1)
      .max(4096)
      .describe(
        'A GFF3 file inside an open DNAForge project. With multiple projects open, ' +
          'prefix a relative path with the project name.'
      ),
    accession: z
      .string()
      .regex(ASSEMBLY_ACCESSION_PATTERN)
      .describe('Versioned accession of the assembly the coordinates are on, e.g. NC_000913.3.'),
    lengthBp: z.number().int().positive().describe('Length of that assembly in bases.'),
    aliases: z
      .array(z.string().min(1))
      .max(16)
      .optional()
      .describe('Other names column 1 may use for this assembly, e.g. U00096.3.'),
    name: z
      .string()
      .regex(TRACK_SLUG_PATTERN)
      .describe('Track name: lowercase letters, digits and hyphens. Becomes the directory name.'),
    kinds: z
      .array(z.enum(['promoter', 'terminator', 'tss', 'transcription_unit']))
      .min(1)
      .max(4)
      .describe('The feature kinds the file provides.'),
    label: z.string().min(1).max(200).describe('Shown in the track panel.'),
    evidence: z.enum(['curated', 'measured', 'computed']),
    licenseAttribution: z
      .string()
      .min(1)
      .max(2000)
      .describe('The exact line DNAForge shows wherever these records appear.'),
    licenseSpdx: z.string().max(64).optional(),
    citation: z.string().max(1000).optional(),
    url: z.string().max(1000).optional(),
    doi: z.string().max(200).optional(),
    datasetVersion: z.string().max(1000).optional(),
    producedBy: z.string().max(500).optional().describe('The tool or command that made the file.'),
    replaceExisting: z
      .boolean()
      .optional()
      .describe('Allow a new version under a name that already holds a differently labelled track.'),
  })
  .strict();

type TrackRegistrationStart = z.infer<typeof managedTrackRegistrationStartSchema>;

interface PreparedTrackRegistration {
  input: Omit<TrackRegistrationStart, 'path'> & { path: string };
}

export function projectManagedTrackRegistrationPreparation(result: unknown): unknown {
  if (!result || typeof result !== 'object' || Array.isArray(result)) return {};
  const value = result as Partial<PreparedTrackRegistration> & { error?: unknown };
  if (!value.input || typeof value.input.name !== 'string') {
    return typeof value.error === 'string' ? { error: value.error } : {};
  }
  return { input: { name: value.input.name, accession: value.input.accession } };
}

export function createPrepareManagedTrackRegistrationTool(folders: WorkspaceFolder[]) {
  return resultTool({
    description:
      'Register a GFF3 file inside an open project as a track in the per-machine track ' +
      'store, so it can be drawn on that assembly. Returns the managed operation ' +
      'immediately so it can be followed from Jobs, the API, the CLI, or agent tools.',
    inputSchema: managedTrackRegistrationStartSchema,
    execute: async ({ path, ...description }) => {
      try {
        const userFolders = getUserFolders(folders);
        if (userFolders.length === 0) {
          return preparationFailure('NO_WORKSPACE', 'Open a project before registering a track.');
        }
        const resolved = resolveMultiRootPath(userFolders, path);
        const [source, root] = await Promise.all([
          platform().fs.stat(resolved.absolutePath),
          platform().fs.stat(resolved.folder.path),
        ]);
        if (!source.isFile || !root.isDirectory) {
          return preparationFailure(
            'INVALID_TRACK_SOURCE',
            'The track file must be a file inside an open project.'
          );
        }
        if (!isPathInsideBoundary(source.canonicalPath, root.canonicalPath)) {
          return preparationFailure(
            'TRACK_SOURCE_OUTSIDE_WORKSPACE',
            'The track file escaped its open project boundary.'
          );
        }
        return toolSuccess({ input: { ...description, path: source.canonicalPath } });
      } catch {
        return preparationFailure(
          'TRACK_SOURCE_RESOLUTION_FAILED',
          'The track file could not be resolved inside an open project.'
        );
      }
    },
  });
}

function preparationFailure(code: string, error: string) {
  return toolFailure({
    code,
    error,
    retriable: false,
    stateChanged: false,
    partialEffects: [],
  });
}
