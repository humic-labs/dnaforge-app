import {
  resultTool,
  toolFailure,
  toolSuccess,
  type ToolPartialEffect,
} from '../../agent-bridge/public/tool-result';
import { z } from 'zod';
import type { WorkspaceFolder } from '../../../stores/workspaceStore';
import { platform } from '../../../platform';
import type { ImportSequenceContentResult } from '../../../shared/workspace-git-types';
import { openManagedSequenceDocument } from '../../document-opening/public/compat';
import { managedSequenceRepository } from '../../sequence/public/managed-sequence-repository';
import { settleImportedSequenceBindings } from '../../sequence/public/settle-imported-sequence-bindings';
import { sequenceResourceUri } from './get-sequence';
import {
  baseName,
  displayPathForResolvedTarget,
  loadSequenceImportSource,
  sanitizeFileName,
  sequenceImportSourceSchema,
} from './sequence-import-source';
import { resolveMultiRootPath, hasNoUserWorkspace, NO_WORKSPACE_TOOL_MESSAGE } from './path-utils';
import { pathRelativeToBoundary } from '../../../shared/path-boundary';
import { defineBlob } from '@waypoint/workspace-revisions';
import { readScientificNamespace } from '../../../services/read-scientific-namespace';
import {
  createDnaSequencePackage,
  normalizeEmptyDnaSequenceName,
  SequenceCreationCollisionError,
  SequenceCreationPendingError,
  type CapturedSequenceCreation,
} from '../../sequence/public/create-empty-dna-sequence';

export const importSequenceSchema = z
  .object({
    copyWithinProject: z
      .boolean()
      .default(false)
      .describe(
        'Create an intentional distinct copy of a source already in the destination project. Otherwise an existing managed sequence is reused and a watched loose source is left to its original publication owner.'
      ),
    source: sequenceImportSourceSchema
      .optional()
      .describe(
        'Canonical import source. Supports local_file paths and NCBI nucleotide accessions; URL/Addgene are reserved adapter shapes.'
      ),
    sourcePath: z
      .string()
      .min(1)
      .max(2000)
      .optional()
      .describe('Legacy shorthand for source={kind:"local_file", path: sourcePath}.'),
    destinationFolder: z
      .string()
      .min(1)
      .max(500)
      .optional()
      .describe('Optional project folder for the managed sequence package. Defaults to imports.'),
    name: z
      .string()
      .min(1)
      .max(200)
      .optional()
      .describe('Optional sequence/package name. Never include a file extension.'),
    label: z
      .string()
      .min(1)
      .max(200)
      .optional()
      .describe('Optional tab label. Defaults to parsed sequence name or file name.'),
    open: z.boolean().default(true).describe('Open the imported sequence tab. Defaults to true.'),
    overwrite: z
      .boolean()
      .default(false)
      .describe('Overwrite an existing target file. Defaults to false.'),
    acceptedImport: z
      .object({
        resourceId: z.string().min(1),
        expectedHead: z.string().min(1),
        sequencePackageText: z.string().min(1),
        contentSha256: z.string().min(1),
      })
      .strict()
      .optional()
      .describe(
        'Exact retry receipt returned by an incomplete accepted import. Repeat the same source and destination with this receipt.'
      ),
  })
  .strict()
  .superRefine((value, context) => {
    const hasSource = value.source !== undefined;
    const hasSourcePath = value.sourcePath !== undefined;
    if (hasSource === hasSourcePath) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: hasSource ? ['sourcePath'] : ['source'],
        message: 'import_sequence requires exactly one of source or sourcePath.',
      });
    }
  });

export function createImportSequenceTool(folders: WorkspaceFolder[]) {
  return resultTool({
    description:
      'Import a sequence source into the open project, open it as a sequence tab, ' +
      'and return its waypoint://sequence resource URI. Supports local GenBank/FASTA files ' +
      'and NCBI nucleotide accessions; URL/Addgene are reserved adapter shapes behind this same tool.',
    inputSchema: importSequenceSchema as z.ZodTypeAny,
    execute: async (
      {
        source,
        sourcePath,
        copyWithinProject,
        destinationFolder,
        name,
        label,
        open = true,
        overwrite = false,
        acceptedImport,
      }: z.infer<typeof importSequenceSchema>,
      context
    ) => {
      const { grantedCapabilities, abortSignal } = context as {
        readonly grantedCapabilities?: readonly string[];
        readonly abortSignal?: AbortSignal;
      };

      if (hasNoUserWorkspace(folders)) {
        return importFailure('NO_WORKSPACE', NO_WORKSPACE_TOOL_MESSAGE);
      }

      let mutationStarted = false;
      let packagesCreated = false;
      let completedCreation: Awaited<ReturnType<typeof createDnaSequencePackage>>['publication'];
      const partialEffects: ToolPartialEffect[] = [];
      if (abortSignal?.aborted) return stoppedBeforeImport('before the download started');
      try {
        const loadedSource = await loadSequenceImportSource(
          folders,
          { source, sourcePath },
          { grantedCapabilities, abortSignal }
        );

        if (abortSignal?.aborted) return stoppedBeforeImport('after the download returned');
        if (name && /\.[A-Za-z0-9]+$/u.test(name.trim())) {
          return importFailure(
            'IMPORT_INVALID_NAME',
            'import_sequence name must not include a file extension.'
          );
        }
        const requestedTargetPath = importDestinationPath({
          defaultFileName: loadedSource.defaultFileName,
          destinationFolder,
          format: loadedSource.parsedFile.format,
          name,
        });
        const target = resolveImportTargetPath(folders, requestedTargetPath);

        const parsedFile = loadedSource.parsedFile;
        const parsed = parsedFile.sequence;
        const localSource = loadedSource.source.absolutePath;
        if (
          !copyWithinProject &&
          localSource &&
          pathRelativeToBoundary(localSource, target.workspaceRoot) !== null
        ) {
          const existing = await managedSequenceRepository.findByMemberPath(localSource);
          if (!existing)
            return importFailure(
              'SOURCE_ALREADY_IN_PROJECT',
              'This source is already inside the watched destination project. Let its existing publication finish and locate its canonical entity with list_files/get_sequence. Do not reimport it to another folder. Use copyWithinProject=true only for an intentional distinct copy.'
            );
          const tabId =
            open && !abortSignal?.aborted
              ? await openManagedSequenceDocument(existing.ref, {
                  label: existing.document.name,
                  strategy: { kind: 'smart' },
                  ...(abortSignal ? { signal: abortSignal } : {}),
                })
              : null;
          return toolSuccess({
            imported: true,
            reused: true,
            source: publicImportSource(loadedSource.source),
            documentId: existing.document.id,
            resourceUri: sequenceResourceUri(existing.document.id),
            documents: [
              {
                documentId: existing.document.id,
                resourceUri: sequenceResourceUri(existing.document.id),
                name: existing.document.name,
              },
            ],
            name: existing.document.name,
            format: parsedFile.format,
            circular: parsed.circular,
            length: parsed.length ?? parsed.sequence?.length ?? 0,
            featureCount: parsedFile.features.length,
            opened: Boolean(tabId),
            tabId,
          });
        }

        const namespace = await readScientificNamespace(target.workspaceRoot);
        if (acceptedImport && !namespace)
          return importFailure(
            'IMPORT_INVALID_DESTINATION',
            'The accepted import project is unavailable. Reopen it before retrying.'
          );
        if (namespace && parsedFile.format !== 'genbank')
          return importFailure(
            'IMPORT_CONVERSION_REQUIRED',
            'Accepted sequence import currently requires a prepared GenBank source.'
          );

        if (abortSignal?.aborted) return stoppedBeforeImport('before anything was written');
        mutationStarted = true;
        let nativeResult: ImportSequenceContentResult;
        if (namespace) {
          const packageName = normalizeEmptyDnaSequenceName(
            fileStem(baseName(target.relativePath))
          );
          const parent = target.relativePath
            .slice(0, -baseName(target.relativePath).length)
            .replace(/[\\/]+$/u, '');
          const destinationPath = parent
            ? `${target.workspaceRoot}/${parent}`
            : target.workspaceRoot;
          const contentSha256 = defineBlob(new TextEncoder().encode(parsedFile.content)).hash;
          if (acceptedImport && acceptedImport.contentSha256 !== contentSha256)
            return importFailure(
              'IMPORT_TARGET_EXISTS',
              'The source changed after this import was accepted. Finish the original import before replacing it.'
            );
          const publication: CapturedSequenceCreation | undefined = acceptedImport && {
            name: packageName,
            destinationPath,
            workspaceRoot: target.workspaceRoot,
            artifactPath: `${destinationPath}/${packageName}/${packageName}.gb`,
            resourceId: acceptedImport.resourceId,
            expectedHead: acceptedImport.expectedHead,
            content: parsedFile.content,
            sequencePackageText: acceptedImport.sequencePackageText,
          };
          const created = await createDnaSequencePackage({
            destinationPath,
            name: packageName,
            content: parsedFile.content,
            open: false,
            requireAccepted: true,
            ...(publication ? { publication, creationId: publication.resourceId } : {}),
          });
          completedCreation = created.publication;
          const packageRoot = created.filePath.slice(0, -(packageName.length + '.gb'.length + 1));
          nativeResult = {
            kind: 'imported',
            destPath: created.filePath,
            relPath: `${parent ? `${parent}/` : ''}${packageName}/${packageName}.gb`,
            packageRoots: [packageRoot],
            packageProductPaths: [created.filePath],
            committed: created.committed,
            replaced: false,
            stateChanged: true,
            partialEffects: [],
          };
        } else {
          nativeResult = await platform().workspace.importSequenceFromContent({
            targetRoot: target.workspaceRoot,
            relativePath: target.relativePath,
            content: parsedFile.content,
            collisionPolicy: overwrite ? 'replace' : 'refuse',
          });
        }
        if (nativeResult.kind !== 'imported') {
          return nativeImportFailure(nativeResult);
        }
        if (nativeResult.packageRoots.length === 0) {
          return nativeImportFailure({
            kind: 'failed',
            code: 'IMPORT_FAILED',
            error: 'The native sequence import returned no managed package.',
            retriable: false,
            stateChanged: true,
            partialEffects: [],
          });
        }
        packagesCreated = true;
        partialEffects.push({
          kind: 'sequence-packages-created',
          count: nativeResult.packageRoots.length,
        });
        const importedDocuments = await Promise.all(
          nativeResult.packageRoots.map((packageRoot) =>
            managedSequenceRepository.openPackage(packageRoot)
          )
        );
        const primaryDocument = importedDocuments[0];
        if (!primaryDocument) throw new Error('The imported sequence package is unavailable.');
        await settleImportedSequenceBindings(importedDocuments, target.workspaceRoot);

        const tabLabel = label ?? parsed.name ?? baseName(target.displayPath);

        const tabId =
          open && !abortSignal?.aborted
            ? await openManagedSequenceDocument(primaryDocument.ref, {
                label: primaryDocument.document.name || tabLabel,
                strategy: { kind: 'smart' },
                ...(abortSignal ? { signal: abortSignal } : {}),
              })
            : null;

        const stoppedAfterCommit = abortSignal?.aborted === true;

        return toolSuccess({
          imported: true,
          ...(stoppedAfterCommit
            ? {
                stopRequested: true,
                note:
                  'Stop arrived after the native import settled. The imported ' +
                  (tabId
                    ? 'document was kept; its tab had already opened before Stop arrived.'
                    : 'document was kept; no tab was opened.'),
              }
            : {}),
          source: publicImportSource(loadedSource.source),
          documentId: primaryDocument.document.id,
          resourceUri: sequenceResourceUri(primaryDocument.document.id),
          documents: importedDocuments.map((document) => ({
            documentId: document.document.id,
            resourceUri: sequenceResourceUri(document.document.id),
            name: document.document.name,
          })),
          name: parsed.name || tabLabel,
          format: parsedFile.format,
          circular: parsed.circular,
          length: parsed.length ?? parsed.sequence?.length ?? 0,
          featureCount: parsedFile.features.length,
          opened: open ? Boolean(tabId) : false,
          tabId,
        });
      } catch (error) {
        if (error instanceof SequenceCreationCollisionError)
          return importFailure(
            'IMPORT_TARGET_EXISTS',
            'A sequence package already exists there. Edit or restore it explicitly.'
          );
        const pending =
          error instanceof SequenceCreationPendingError
            ? { creation: error.creation, accepted: error.accepted }
            : completedCreation;
        if (pending) {
          const creation = pending.creation;
          return {
            ...toolFailure({
              code: 'IMPORT_PUBLICATION_PENDING',
              error:
                'The sequence import was accepted; delivery, project history or opening remains incomplete. Retry unchanged with the returned acceptedImport receipt.',
              retriable: true,
              stateChanged: true,
              partialEffects: [
                { kind: 'sequence-import-accepted', resourceId: creation.resourceId },
              ],
              details: {
                accepted: pending.accepted,
                acceptedImport: {
                  resourceId: creation.resourceId,
                  expectedHead: creation.expectedHead,
                  sequencePackageText: creation.sequencePackageText,
                  contentSha256: defineBlob(new TextEncoder().encode(creation.content)).hash,
                },
              },
            }),
            imported: false as const,
          };
        }

        if (!mutationStarted && (isAbortError(error) || abortSignal?.aborted)) {
          return stoppedBeforeImport('while the source was being prepared');
        }
        return {
          ...importFailure(
            'IMPORT_FAILED',
            `Failed to import sequence: ${
              error instanceof Error ? redactPhysicalSequencePaths(error.message) : 'Unknown error'
            }`
          ),
          stateChanged: packagesCreated ? true : mutationStarted ? ('unknown' as const) : false,
          partialEffects,
        };
      }
    },
  });
}

function fileStem(fileName: string): string {
  return fileName.replace(/\.(?:gb|gbk|gbff|genbank|fa|fas|fasta|fna|ffn)$/iu, '');
}

function importDestinationPath(input: {
  defaultFileName: string;
  destinationFolder?: string;
  format: 'genbank' | 'fasta' | 'gff3';
  name?: string;
}): string {
  const folder = (input.destinationFolder ?? 'imports').replace(/[\\/]+$/u, '');
  const defaultName = fileStem(baseName(input.defaultFileName));
  const stem = fileStem(sanitizeFileName(input.name?.trim() || defaultName));
  const extension = input.format === 'fasta' ? '.fasta' : '.gb';
  return `${folder}/${stem}${extension}`;
}

function publicImportSource(
  source: Awaited<ReturnType<typeof loadSequenceImportSource>>['source']
) {
  const { path: _path, absolutePath: _absolutePath, ...publicSource } = source;
  return publicSource;
}

function redactPhysicalSequencePaths(message: string): string {
  return message.replace(
    /(?:[A-Za-z]:)?[^\s"']+\.(?:gb|gbk|gbff|genbank|fa|fas|fasta|fna|ffn)/giu,
    '[sequence source]'
  );
}

type ResolvedImportPath = {
  displayPath: string;
  workspaceRoot: string;
  relativePath: string;
};

function resolveImportTargetPath(
  folders: WorkspaceFolder[],
  targetPath: string
): ResolvedImportPath {
  const resolved = resolveMultiRootPath(folders, targetPath);
  return {
    displayPath: displayPathForResolvedTarget(folders, resolved),
    workspaceRoot: resolved.folder.path,
    relativePath: resolved.relativePath,
  };
}

function nativeImportFailure(result: Exclude<ImportSequenceContentResult, { kind: 'imported' }>) {
  return {
    ...toolFailure({
      code: result.code,
      error:
        result.code === 'IMPORT_COMMIT_FAILED'
          ? 'The managed sequence package was created, but its repository commit failed.'
          : result.code === 'IMPORT_FAILED'
            ? 'The native sequence import did not settle cleanly.'
            : redactPhysicalSequencePaths(result.error),
      retriable: result.retriable,
      stateChanged: result.stateChanged,
      partialEffects: result.partialEffects.map((effect) =>
        effect.kind === 'sequence-packages-created'
          ? { kind: effect.kind, count: effect.count }
          : {
              kind: effect.kind,
              note: 'Native recovery data was retained; inspect the application operation record.',
            }
      ),
    }),
    imported: false as const,
  };
}

function importFailure(code: string, error: string) {
  return {
    ...toolFailure({ code, error, retriable: false, stateChanged: false, partialEffects: [] }),
    imported: false as const,
  };
}

function stoppedBeforeImport(when: string) {
  return {
    ...toolFailure({
      code: 'CANCELED',
      error: `Sequence import was stopped ${when}. Nothing was written, packaged, or opened.`,
      retriable: true,
      stateChanged: false,
      partialEffects: [],
    }),
    imported: false as const,
    canceled: true as const,
  };
}

function isAbortError(error: unknown): boolean {
  return (error instanceof Error || error instanceof DOMException) && error.name === 'AbortError';
}
