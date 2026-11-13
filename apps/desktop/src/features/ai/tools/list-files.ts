import { resultTool, toolSuccess, toolFailure } from '../../agent-bridge/public/tool-result';
import { z } from 'zod';
import { platform } from '../../../platform';
import type { WorkspaceFolder } from '../../../stores/workspaceStore';
import {
  resolveMultiRootPath,
  getUserFolders,
  hasNoUserWorkspace,
  NO_WORKSPACE_TOOL_MESSAGE,
} from './path-utils';
import { getCatalogEntityForFilePath } from '../../../db/workspace-catalog';
import { managedSequenceRepository } from '../../sequence/public/managed-sequence-repository';
import { sequenceResourceUri } from './get-sequence';
import { HARD_CAP_BYTES } from '../../../shared/oversized-guard';
import { resolveExplicitProjectRoot } from '../../../shared/project-root-selection';

const BIOLOGY_EXTENSIONS = new Set(['gb', 'gbk', 'genbank', 'fasta', 'fa', 'fas', 'fna', 'seq']);
const MAX_BIOLOGY_SEARCH_BYTES = 256 * 1024;

const EXCLUDED_DIRS = new Set(['node_modules', '.git', '.svn', '__pycache__', '.DS_Store']);

function getExtension(filename: string): string | undefined {
  const lastDot = filename.lastIndexOf('.');
  if (lastDot === -1 || lastDot === filename.length - 1) return undefined;
  return filename.slice(lastDot + 1).toLowerCase();
}

function isBiologyFile(filename: string): boolean {
  const ext = getExtension(filename);
  return ext !== undefined && BIOLOGY_EXTENSIONS.has(ext);
}

function searchableBiologyMetadata(path: string, text: string): string {
  const extension = getExtension(path);
  if (extension === 'fasta' || extension === 'fa' || extension === 'fas' || extension === 'fna') {
    return text
      .split(/\r?\n/u)
      .filter((line) => line.startsWith('>'))
      .join('\n');
  }

  if (extension === 'gb' || extension === 'gbk' || extension === 'genbank') {
    return text
      .split(/^\/\/[ \t]*(?:\r?\n|$)/mu)
      .map((record) => {
        const origin = /^[ \t]*ORIGIN(?:[ \t]|$)/imu.exec(record);
        return origin?.index === undefined ? record : record.slice(0, origin.index);
      })
      .join('\n');
  }

  return '';
}

function biologyQueryMatchRank(metadata: string, normalizedQuery: string): 0 | 1 | 2 | 3 {
  const annotatedIdentifiers = metadata.matchAll(/^\s*\/(?:gene|locus_tag)="([^"\r\n]+)"/gmu);
  if ([...annotatedIdentifiers].some((match) => match[1].toLocaleLowerCase() === normalizedQuery))
    return 3;
  const normalizedMetadata = metadata.toLocaleLowerCase();
  if (normalizedQuery.length > 3) return normalizedMetadata.includes(normalizedQuery) ? 2 : 0;

  const tokens = normalizedMetadata.split(/[^a-z0-9]+/u);
  if (tokens.some((token) => token === normalizedQuery)) return 2;
  return tokens.some((token) => token.startsWith(normalizedQuery)) ? 1 : 0;
}

function biologyMatchEvidence(
  metadata: string,
  normalizedQuery: string,
  matchRank: 1 | 2 | 3
): string[] {
  return metadata
    .split(/\r?\n/u)
    .filter((line) => biologyQueryMatchRank(line, normalizedQuery) === matchRank)
    .map((line) => line.trim().replace(/\s+/gu, ' ').slice(0, 240))
    .filter(Boolean)
    .slice(0, 3);
}

async function readBiologyMetadata(path: string, singleRecord: boolean) {
  let budget = MAX_BIOLOGY_SEARCH_BYTES;
  for (;;) {
    const slice = await platform().fs.readTextFileSlice(path, budget);
    const genbank = ['gb', 'gbk', 'genbank', 'seq'].includes(getExtension(path) ?? '');
    const complete =
      slice.bytesRead < budget ||
      (singleRecord && genbank && /^[ \t]*ORIGIN(?:[ \t]|$)/imu.test(slice.text));
    if (complete || budget === HARD_CAP_BYTES)
      return { metadata: searchableBiologyMetadata(path, slice.text), partial: !complete };
    budget = Math.min(budget * 2, HARD_CAP_BYTES);
  }
}

function usesFolderNamePrefix(inputPath: string | undefined, folder: WorkspaceFolder): boolean {
  const firstSegment = (inputPath || '').split('/').filter(Boolean)[0] ?? '';
  return firstSegment.toLowerCase() === folder.name.toLowerCase();
}

export interface FileListEntry {
  name: string;
  path?: string;
  type: 'file' | 'directory' | 'sequence-document' | 'sequence-source';
  size?: number;
  extension?: string;
  isBiologyFile: boolean;
  documentId?: string;
  nextOpenInput?: { type: 'sequence'; entityId: string };
  nextInspectionInput?: { documentId: string; operation: { kind: 'inspect' } };
  resourceUri?: string;
  importRequired?: boolean;
  biologyMatches?: string[];
  biologySearchPartial?: boolean;
}

const projectScopeSchema = z
  .string()
  .min(1)
  .optional()
  .describe('Exact mounted project name or root from get_workspace; restrict discovery to it.');

export const listFilesSchema = z
  .object({
    project: projectScopeSchema,
    path: z
      .string()
      .optional()
      .describe('Path inside the mounted workspace. Use "." or omit for the root.'),
    recursive: z
      .boolean()
      .optional()
      .describe('If true, list all files recursively. Default is false.'),
    nameQuery: z
      .string()
      .min(1)
      .max(200)
      .optional()
      .describe(
        'Optional nonempty case-insensitive name filter. Omit nameQuery to list without a name filter; do not send an empty string. Use recursive=true to search before the 100-entry result cap.'
      ),
    biologyQuery: z
      .string()
      .min(1)
      .max(200)
      .optional()
      .describe(
        'Optional nonempty case-insensitive sequence metadata filter. Omit biologyQuery when no metadata filter is needed; do not send an empty string. Searches bounded GenBank/FASTA headers and annotations, including feature labels absent from package names, before the 100-entry result cap. Queries of three or fewer characters prefer a discrete metadata token, then a token prefix. Matches include bounded biologyMatches evidence.'
      ),
  })
  .strict();

export const listFilesOutputSchema = z.object({
  ok: z.literal(true),
  path: z.string(),
  count: z.number().int().nonnegative(),
  entries: z.array(
    z.object({
      name: z.string(),
      path: z.string().optional(),
      type: z.enum(['file', 'directory', 'sequence-document', 'sequence-source']),
      size: z.number().optional(),
      extension: z.string().optional(),
      isBiologyFile: z.boolean(),
      documentId: z.string().optional(),
      nextOpenInput: z.object({ type: z.literal('sequence'), entityId: z.string() }).optional(),
      nextInspectionInput: z
        .object({
          documentId: z.string(),
          operation: z.object({ kind: z.literal('inspect') }),
        })
        .optional(),
      resourceUri: z.string().optional(),
      importRequired: z.boolean().optional(),
      biologyMatches: z.array(z.string()).optional(),
      biologySearchPartial: z.boolean().optional(),
    })
  ),
  nameQuery: z.string().optional(),
  searchScope: z
    .union([
      z.object({ kind: z.literal('recursive') }),
      z.object({
        kind: z.literal('current_directory'),
        unsearchedDirectoryCount: z.number().int().nonnegative(),
        nextSearchInput: z
          .object({
            project: z.string().optional(),
            path: z.string(),
            recursive: z.literal(true),
            nameQuery: z.string().optional(),
            biologyQuery: z.string().optional(),
          })
          .optional(),
        nextAction: z.string().optional(),
      }),
    ])
    .optional(),
  biologyQuery: z.string().optional(),
  biologyFilesSearched: z.number().int().nonnegative().optional(),
  biologyFilesPartiallySearched: z.number().int().nonnegative().optional(),
  biologyFilesUnreadable: z.number().int().nonnegative().optional(),
  biologySearchBytesPerFile: z.number().int().optional(),
  biologyResolution: z
    .object({
      status: z.enum(['matching_sources_found', 'no_matching_sources', 'search_incomplete']),
      matchingSourceExists: z.boolean().nullable(),
      recommendedDocumentId: z.string().nullable(),
      recommendedName: z.string().nullable(),
      nextAction: z.string(),
    })
    .optional(),
  truncated: z.boolean().optional(),
  truncatedMessage: z.string().optional(),
});

export function createListFilesTool(folders: WorkspaceFolder[]) {
  const userFolders = getUserFolders(folders);
  const isMultiUserFolder = userFolders.length > 1;

  const inputSchema = listFilesSchema.extend({
    path: listFilesSchema.shape.path.describe(
      isMultiUserFolder
        ? 'Path to list, prefixed with folder name (e.g., "Lab Data/subdir"). Omit to list all folders.'
        : 'Path to list, relative to the project root. Use "." or omit for root.'
    ),
  });

  return resultTool({
    description:
      "List files and directories in a path within the user's project. " +
      'Use this to explore generic files and stable sequence documents. Managed sequence ' +
      'packages are collapsed to documentId/resourceUri entries; their physical product files are never returned. ' +
      (isMultiUserFolder
        ? 'Prefix paths with the folder name (e.g., "Lab Data/plasmids"). ' +
          'Omit path to see all project folders.'
        : ''),
    inputSchema: inputSchema as z.ZodTypeAny,
    execute: async ({
      project,
      path: relativePath,
      recursive,
      nameQuery,
      biologyQuery,
    }: z.infer<typeof inputSchema>) => {
      if (hasNoUserWorkspace(folders)) {
        return {
          path: relativePath || '.',
          entries: [],
          count: 0,
          ...toolFailure({
            code: 'NO_WORKSPACE',
            error: NO_WORKSPACE_TOOL_MESSAGE,
            retriable: false,
            stateChanged: false,
            partialEffects: [],
          }),
        };
      }
      const prefix = relativePath?.split('/').filter(Boolean)[0];
      const ambiguous =
        project !== undefined
          ? folders.filter(
              (folder) => folder.name.toLocaleLowerCase() === project.toLocaleLowerCase()
            )
          : prefix
            ? folders.filter(
                (folder) => folder.name.toLocaleLowerCase() === prefix.toLocaleLowerCase()
              )
            : [];
      if (ambiguous.length > 1) {
        const path =
          project !== undefined
            ? (relativePath ?? '.')
            : relativePath!.split('/').slice(1).join('/') || '.';
        return {
          path: relativePath ?? '.',
          entries: [],
          count: 0,
          ...toolFailure({
            code: 'PROJECT_AMBIGUOUS',
            error:
              'Multiple mounted projects have that name. Retry with one exact project root from details.nextInputs.',
            retriable: false,
            stateChanged: false,
            partialEffects: [],
            details: {
              nextInputs: ambiguous.map((folder) => ({
                project: folder.path,
                path,
                ...(recursive !== undefined ? { recursive } : {}),
                ...(nameQuery !== undefined ? { nameQuery } : {}),
                ...(biologyQuery !== undefined ? { biologyQuery } : {}),
              })),
            },
          }),
        };
      }
      let scopedFolders = folders;
      if (project !== undefined) {
        const selected = resolveExplicitProjectRoot(folders, project);
        if (!selected)
          return {
            path: relativePath || '.',
            entries: [],
            count: 0,
            ...toolFailure({
              code: 'PROJECT_NOT_ADMITTED',
              error: 'Choose a unique mounted project by exact name or root from get_workspace.',
              retriable: false,
              stateChanged: false,
              partialEffects: [],
            }),
          };
        scopedFolders = [selected];
      }
      const scopedUserFolders = getUserFolders(scopedFolders);
      const isMultiUserFolder = scopedUserFolders.length > 1;
      const visibleFolders = scopedUserFolders.length > 0 ? scopedUserFolders : scopedFolders;
      const normalizedNameQuery = nameQuery?.trim().toLocaleLowerCase();
      const normalizedBiologyQuery = biologyQuery?.trim().toLocaleLowerCase();
      const isRootRequest = !relativePath || relativePath === '.';
      const searchAllUserFolders =
        isRootRequest &&
        isMultiUserFolder &&
        Boolean(normalizedNameQuery || normalizedBiologyQuery);

      if (isRootRequest && isMultiUserFolder && !searchAllUserFolders) {
        return toolSuccess({
          path: '.',
          entries: visibleFolders.map((f) => ({
            name: f.name,
            path: f.name,
            type: 'directory' as const,
            isBiologyFile: false,
          })),
          count: visibleFolders.length,
        });
      }

      const searchTargets = searchAllUserFolders
        ? visibleFolders.map((folder) => ({
            target: folder.path,
            pathPrefix: folder.name,
          }))
        : (() => {
            const resolved = resolveMultiRootPath(scopedFolders, relativePath || '.');
            const shouldPrefixWithFolderName =
              isMultiUserFolder || usesFolderNamePrefix(relativePath, resolved.folder);
            const pathPrefix = shouldPrefixWithFolderName
              ? resolved.relativePath
                ? `${resolved.folder.name}/${resolved.relativePath}`
                : resolved.folder.name
              : resolved.relativePath || '';
            return [{ target: resolved.absolutePath, pathPrefix }];
          })();

      const entries: Array<{
        entry: FileListEntry;
        biologyContentPath?: string;
      }> = [];

      const addEntry = (entry: FileListEntry, biologyContentPath?: string) => {
        const hints: Pick<FileListEntry, 'nextOpenInput' | 'nextInspectionInput'> = entry.documentId
          ? {
              nextOpenInput: { type: 'sequence', entityId: entry.documentId },
              nextInspectionInput: {
                documentId: entry.documentId,
                operation: { kind: 'inspect' },
              },
            }
          : {};
        entries.push({ entry: { ...entry, ...hints }, biologyContentPath });
      };

      async function listDirectory(dirPath: string, basePath: string): Promise<void> {
        const items = await platform().fs.readDir(dirPath);

        for (const item of items) {
          if (EXCLUDED_DIRS.has(item.name) || item.name.startsWith('.')) {
            continue;
          }

          const relPath = basePath ? `${basePath}/${item.name}` : item.name;
          const absolutePath = `${dirPath}/${item.name}`;

          if (item.isDirectory) {
            const managed = await managedSequenceRepository
              .openPackage(absolutePath)
              .catch(() => null);
            if (managed) {
              addEntry(
                {
                  name: managed.document.name || item.name,
                  type: 'sequence-document',
                  isBiologyFile: true,
                  documentId: managed.document.id,
                  resourceUri: sequenceResourceUri(managed.document.id),
                },
                managed.productPath
              );
              continue;
            }
            addEntry({
              name: item.name,
              path: relPath,
              type: 'directory',
              isBiologyFile: false,
            });

            if (recursive) {
              await listDirectory(absolutePath, relPath);
            }
          } else {
            if (isBiologyFile(item.name)) {
              const managed = await managedSequenceRepository.findByMemberPath(absolutePath);
              const catalog = managed ? null : await getCatalogEntityForFilePath(absolutePath);
              const documentId = managed?.document.id ?? catalog?.id ?? null;
              addEntry(
                documentId
                  ? {
                      name: managed?.document.name || item.name,
                      type: 'sequence-document',
                      isBiologyFile: true,
                      documentId,
                      resourceUri: sequenceResourceUri(documentId),
                    }
                  : {
                      name: item.name,
                      type: 'sequence-source',
                      isBiologyFile: true,
                      importRequired: true,
                    },
                managed?.productPath ?? absolutePath
              );
              continue;
            }
            addEntry({
              name: item.name,
              path: relPath,
              type: 'file',
              extension: getExtension(item.name),
              isBiologyFile: isBiologyFile(item.name),
            });
          }
        }
      }

      for (const searchTarget of searchTargets) {
        await listDirectory(searchTarget.target, searchTarget.pathPrefix);
      }
      let biologyFilesSearched = 0;
      let biologyFilesPartiallySearched = 0;
      let biologyFilesUnreadable = 0;
      const matchingEntries: FileListEntry[] = [];
      const fallbackBiologyEntries: FileListEntry[] = [];
      const biologyRanks = new Map<FileListEntry, number>();

      for (const candidate of entries) {
        const nameMatches =
          !normalizedNameQuery ||
          `${candidate.entry.name}\n${candidate.entry.path ?? ''}`
            .toLocaleLowerCase()
            .includes(normalizedNameQuery);
        if (!nameMatches) continue;

        if (normalizedBiologyQuery) {
          if (!candidate.biologyContentPath) continue;
          try {
            const { metadata, partial } = await readBiologyMetadata(
              candidate.biologyContentPath,
              candidate.entry.type === 'sequence-document'
            );
            biologyFilesSearched += 1;
            if (partial) biologyFilesPartiallySearched += 1;
            const matchRank = biologyQueryMatchRank(metadata, normalizedBiologyQuery);
            if (matchRank === 0) continue;
            const matchedEntry = {
              ...candidate.entry,
              biologyMatches: biologyMatchEvidence(metadata, normalizedBiologyQuery, matchRank),
              biologySearchPartial: partial,
            };
            biologyRanks.set(matchedEntry, matchRank);
            if (matchRank === 1) fallbackBiologyEntries.push(matchedEntry);
            else matchingEntries.push(matchedEntry);
            continue;
          } catch {
            biologyFilesUnreadable += 1;
            continue;
          }
        }

        matchingEntries.push(candidate.entry);
      }

      if (normalizedBiologyQuery && matchingEntries.length === 0) {
        matchingEntries.push(...fallbackBiologyEntries);
      }

      matchingEntries.sort((a, b) => {
        const biologyRank = (biologyRanks.get(b) ?? 0) - (biologyRanks.get(a) ?? 0);
        if (biologyRank !== 0) return biologyRank;
        if (a.type === 'directory' && b.type !== 'directory') return -1;
        if (a.type !== 'directory' && b.type === 'directory') return 1;
        return a.name.toLowerCase().localeCompare(b.name.toLowerCase());
      });

      const MAX_ENTRIES = 100;
      const totalCount = matchingEntries.length;
      const truncated = totalCount > MAX_ENTRIES;
      const bioCount = matchingEntries.filter((e) => e.isBiologyFile).length;
      const recommendedBiologySource = matchingEntries[0];
      const biologySearchIncomplete =
        biologyFilesPartiallySearched > 0 || biologyFilesUnreadable > 0;

      const unsearchedDirectoryCount = recursive
        ? 0
        : entries.filter(({ entry }) => entry.type === 'directory').length;

      return toolSuccess({
        path: relativePath || '.',
        ...(normalizedNameQuery || normalizedBiologyQuery
          ? {
              searchScope: recursive
                ? { kind: 'recursive' as const }
                : {
                    kind: 'current_directory' as const,
                    unsearchedDirectoryCount,
                    ...(unsearchedDirectoryCount > 0
                      ? {
                          nextSearchInput: {
                            ...(project !== undefined ? { project } : {}),
                            path: relativePath || '.',
                            recursive: true,
                            ...(normalizedNameQuery ? { nameQuery: nameQuery!.trim() } : {}),
                            ...(normalizedBiologyQuery
                              ? { biologyQuery: biologyQuery!.trim() }
                              : {}),
                          },
                          nextAction:
                            'Subdirectories were not searched. Run nextSearchInput before concluding that the target is missing.',
                        }
                      : {}),
                  },
            }
          : {}),
        ...(normalizedNameQuery ? { nameQuery: nameQuery!.trim() } : {}),
        ...(normalizedBiologyQuery
          ? {
              biologyQuery: biologyQuery!.trim(),
              biologyFilesSearched,
              biologyFilesPartiallySearched,
              biologyFilesUnreadable,
              biologySearchBytesPerFile: HARD_CAP_BYTES,
              biologyResolution:
                totalCount > 0
                  ? {
                      status: 'matching_sources_found' as const,
                      matchingSourceExists: true,
                      recommendedDocumentId: recommendedBiologySource?.documentId ?? null,
                      recommendedName:
                        recommendedBiologySource?.name ?? matchingEntries[0]?.name ?? null,
                      nextAction: recommendedBiologySource?.documentId
                        ? 'Inspect recommendedDocumentId with get_sequence before concluding that this biological source is missing.'
                        : 'A matching biological source exists but is not yet a stable sequence document. Import a matching entry before concluding that the source is missing.',
                    }
                  : {
                      status: biologySearchIncomplete
                        ? ('search_incomplete' as const)
                        : ('no_matching_sources' as const),
                      matchingSourceExists: biologySearchIncomplete ? null : false,
                      recommendedDocumentId: null,
                      recommendedName: null,
                      nextAction: biologySearchIncomplete
                        ? 'Some source metadata was unreadable or exceeded the supported read limit. Source existence is unknown; inspect those sources before concluding that it is missing.'
                        : 'No matching metadata exists in the searched scope. Search other relevant projects before concluding that this source is unavailable.',
                    },
            }
          : {}),
        entries: truncated ? matchingEntries.slice(0, MAX_ENTRIES) : matchingEntries,
        count: totalCount,
        ...(truncated && {
          truncated: true,
          truncatedMessage: `Showing first ${MAX_ENTRIES} of ${totalCount} items (${bioCount} biology files total). Use a more specific path, nameQuery, or biologyQuery to narrow results.`,
        }),
      });
    },
  });
}
