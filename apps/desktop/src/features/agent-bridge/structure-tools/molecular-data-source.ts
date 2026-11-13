import { z } from 'zod';
import { platform } from '../../../platform';
import type { WorkspaceFolder } from '../../../stores/workspaceStore';
import { isPathInsideBoundary } from '../../../shared/path-boundary';
import { getUserFolders, resolveMultiRootPath } from '../../workspace/public/path-resolve';
import { sha256Hex } from '../../structure-drawer/public/api/protein-identity';
import { molecularDataPublicationSchema } from '../../page/public/embeds/structure3d/molecularData';
import type { FilesystemStat } from '../../../shared/filesystem-stat';

const tableSourceSchema = z
  .object({
    format: z.enum(['csv', 'tsv']),
    text: z.string().min(1).max(2_000_000).optional(),
    path: z
      .string()
      .min(1)
      .max(4096)
      .optional()
      .describe(
        'CSV/TSV file inside an open workspace. The app reads and preserves its exact bytes; do not copy the table through model prose.'
      ),
    sha256: z
      .string()
      .regex(/^[0-9a-f]{64}$/)
      .optional()
      .describe(
        'Optional SHA-256 of the exact generated file: 64 hexadecimal characters. Omit this field if you have not obtained the digest; never send an empty string or placeholder. The app always records the actual imported file digest.'
      ),
  })
  .strict()
  .superRefine((value, context) => {
    if ((value.text !== undefined) === (value.path !== undefined))
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Supply table text or a workspace file path, exactly one.',
      });
  });

export const molecularDataPublicationRequestSchema = molecularDataPublicationSchema
  .innerType()
  .extend({
    table: tableSourceSchema.optional(),
    source: molecularDataPublicationSchema.innerType().shape.source.extend({
      programPath: z
        .string()
        .min(1)
        .max(4096)
        .optional()
        .describe(
          'Executed analysis program inside the open workspace. The app retains its exact text and SHA-256 independently of the mutable file.'
        ),
      programSha256: z
        .string()
        .regex(/^[0-9a-f]{64}$/)
        .optional(),
    }),
  })
  .superRefine((value, context) => {
    if ((value.records !== undefined) === (value.table !== undefined))
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Supply records or a table, exactly one.',
      });
    if (
      (value.source.programPath && value.source.program) ||
      (value.source.programSha256 && !value.source.programPath)
    )
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Supply an exact program or programPath; programSha256 requires programPath.',
      });
  });

export async function loadMolecularDataPublication(
  request: z.infer<typeof molecularDataPublicationRequestSchema>,
  folders: WorkspaceFolder[]
) {
  const { programPath, programSha256, ...source } = request.source;
  if (programPath) {
    const program = await readWorkspaceTextArtifact(programPath, folders, 1_000_000);
    if (programSha256 && programSha256 !== program.sha256)
      throw new Error('The analysis program changed from the requested digest.');
    source.program = { path: programPath, ...program };
  }
  let table: { format: 'csv' | 'tsv'; text: string } | undefined;
  if (request.table) {
    const imported = request.table.path
      ? await readWorkspaceTextArtifact(request.table.path, folders, 2_000_000)
      : { text: request.table.text!, sha256: await sha256Hex(request.table.text!) };
    if (request.table.sha256 && request.table.sha256 !== imported.sha256)
      throw new Error('The molecular data file changed from the requested digest.');
    table = { format: request.table.format, text: imported.text };
    if (request.table.path)
      source.metadata = {
        ...source.metadata,
        tableFile: {
          path: request.table.path,
          sha256: imported.sha256,
        },
      };
  }
  return molecularDataPublicationSchema.parse({ ...request, source, table });
}

async function readWorkspaceTextArtifact(path: string, folders: WorkspaceFolder[], limit: number) {
  const resolved = resolveMultiRootPath(getUserFolders(folders), path);
  const [file, root] = await Promise.all([
    platform().fs.stat(resolved.absolutePath),
    platform().fs.stat(resolved.folder.path),
  ]);
  if (
    !file.isFile ||
    !root.isDirectory ||
    !isPathInsideBoundary(file.canonicalPath, root.canonicalPath)
  )
    throw new Error('The analysis artifact must be inside its open workspace.');
  if (file.size > limit) throw new Error('The analysis artifact exceeds its retention limit.');
  const bytes = await platform().fs.readFile(file.canonicalPath);
  const text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
  const [after, rootAfter] = await Promise.all([
    platform().fs.stat(resolved.absolutePath),
    platform().fs.stat(resolved.folder.path),
  ]);
  if (
    generation(file) !== generation(after) ||
    JSON.stringify([root.canonicalPath, root.device, root.inode, root.isDirectory]) !==
      JSON.stringify([
        rootAfter.canonicalPath,
        rootAfter.device,
        rootAfter.inode,
        rootAfter.isDirectory,
      ]) ||
    bytes.byteLength !== file.size
  )
    throw new Error('The analysis artifact changed while it was being retained.');
  const sha256 = await sha256Hex(text);
  return { text, sha256 };
}

function generation(stat: FilesystemStat): string {
  return JSON.stringify([
    stat.canonicalPath,
    stat.size,
    stat.isFile,
    stat.isDirectory,
    stat.mtimeNs,
    stat.ctimeNs,
    stat.device,
    stat.inode,
  ]);
}
