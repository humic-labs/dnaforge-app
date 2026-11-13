import { withUserMessage } from '@waypoint/user-messages';
import {
  fromPackageRelative,
  isSequencePackageFileKind,
  parseSequencePackageDocument,
} from '../../db/sequence-package';
import { locateSequencePackageMetaPath } from '../../db/sequence-package-io';
import { getCurrentCatalogFileForEntity, markCatalogFileMissing } from '../../db/workspace-catalog';
import { platform } from '../../platform';
import { pathIsAtOrUnder } from '../../shared/path-boundary';
import { resumeDesignArtifactMirror, retireDesignArtifactMirror } from './design-artifact-mirror';

interface CurrentDesignArtifactBinding {
  path: string;
  relative_path: string | null;
  file_kind: string;
}

export interface DesignArtifactMaturationDeps {
  getCurrentBinding(designId: string): Promise<CurrentDesignArtifactBinding | null>;
  retireMirror(designId: string): Promise<void>;
  resumeMirror(designId: string): void;
  ensureConstructBinding(input: {
    constructId: string;
    packageRoot: string;
    name: string;
    workspaceRoot: string;
    designId: string;
    mutationToken?: string;
  }): Promise<void>;
  markDesignDraftMissing(path: string): Promise<void>;
  removeDraft(path: string, mutationToken?: string): Promise<void>;
}

export type DesignArtifactMaturationResult =
  | { state: 'not-file-backed' }
  | { state: 'already-matured'; packageRoot: string }
  | { state: 'matured'; draftPath: string; packageRoot: string };

interface ResolvedDesignArtifactMaturationTarget {
  draftPath: string;
  packageRoot: string;
  workspaceRoot: string;
}

const DEFAULT_DEPS: DesignArtifactMaturationDeps = {
  getCurrentBinding: getCurrentCatalogFileForEntity,
  retireMirror: retireDesignArtifactMirror,
  resumeMirror: resumeDesignArtifactMirror,
  ensureConstructBinding: defaultEnsureConstructBinding,
  markDesignDraftMissing: async (path) => {
    await markCatalogFileMissing(path, 'consumed-working-copy');
  },
  removeDraft: (path, mutationToken) => platform().shell.trashItem(path, mutationToken),
};

async function defaultEnsureConstructBinding(input: {
  constructId: string;
  packageRoot: string;
  name: string;
  workspaceRoot: string;
  designId: string;
  mutationToken?: string;
}): Promise<void> {
  const fs = platform().fs;
  const metaPath = await locateSequencePackageMetaPath(input.packageRoot, fs.exists);
  if (!metaPath) throw new Error('The published construct package is unavailable.');
  const packageDocument = parseSequencePackageDocument(await fs.readTextFile(metaPath));
  if (packageDocument.id !== input.constructId)
    throw new Error('The published package does not belong to the accepted construct.');
  const { registerAcceptedAssemblyAsLimsEntity } = await import('../lims/public/assembly-bridge');
  await registerAcceptedAssemblyAsLimsEntity({
    packageDocument,
    productGenBankContent: await fs.readTextFile(
      fromPackageRelative(packageDocument.product.file, input.packageRoot)
    ),
    packageRoot: input.packageRoot,
    workspaceRoot: input.workspaceRoot,
    mutationToken: input.mutationToken,
  });
}

function normalizePath(path: string): string {
  const normalized = path.replace(/\\/g, '/').replace(/\/+$/, '');
  return normalized || '/';
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function workspaceRootFromBinding(binding: CurrentDesignArtifactBinding): string | null {
  if (binding.relative_path === null) return null;
  if (binding.relative_path === '') return normalizePath(binding.path);
  const normalizedPath = normalizePath(binding.path);
  const normalizedRelative = binding.relative_path.replace(/\\/g, '/').replace(/^\/+/, '');
  const suffix = `/${normalizedRelative}`;
  return normalizedPath.endsWith(suffix) ? normalizedPath.slice(0, -suffix.length) || '/' : null;
}

async function resolveDesignArtifactMaturationTarget(
  input: {
    designId: string;
    packageRoot: string;
    workspaceRoot?: string | null;
  },
  deps: DesignArtifactMaturationDeps
): Promise<
  | { state: 'not-file-backed' }
  | { state: 'already-matured'; packageRoot: string; workspaceRoot: string }
  | { state: 'ready'; target: ResolvedDesignArtifactMaturationTarget }
> {
  const packageRoot = normalizePath(input.packageRoot);
  const binding = await deps.getCurrentBinding(input.designId);
  if (!binding) return { state: 'not-file-backed' };

  const draftPath = normalizePath(binding.path);
  if (isSequencePackageFileKind(binding.file_kind)) {
    if (draftPath !== packageRoot) {
      throw new Error(
        `Design "${input.designId}" is already bound to a different sequence package: ${draftPath}`
      );
    }
    const resolvedWorkspaceRoot = workspaceRootFromBinding(binding) ?? input.workspaceRoot;
    if (!resolvedWorkspaceRoot) {
      throw new Error(`Cannot determine the project for sequence package "${packageRoot}".`);
    }
    const workspaceRoot = normalizePath(resolvedWorkspaceRoot);
    if (!pathIsAtOrUnder(packageRoot, workspaceRoot)) {
      throw withUserMessage(
        new Error(
          `Cannot normalize legacy design "${input.designId}" outside its workspace: ${packageRoot}`
        ),
        'assembly.outsideProject'
      );
    }
    return { state: 'already-matured', packageRoot, workspaceRoot };
  }
  if (binding.file_kind !== 'waypoint-design') {
    throw new Error(
      `Cannot mature design "${input.designId}" from catalog kind "${binding.file_kind}".`
    );
  }

  const resolvedWorkspaceRoot = workspaceRootFromBinding(binding) ?? input.workspaceRoot;
  if (!resolvedWorkspaceRoot) {
    throw new Error(`Cannot determine the project for design draft "${draftPath}".`);
  }
  const workspaceRoot = normalizePath(resolvedWorkspaceRoot);
  if (!pathIsAtOrUnder(draftPath, workspaceRoot) || !pathIsAtOrUnder(packageRoot, workspaceRoot)) {
    throw withUserMessage(
      new Error(`Cannot mature design "${input.designId}" outside its workspace: ${packageRoot}`),
      'assembly.outsideProject'
    );
  }
  return {
    state: 'ready',
    target: { draftPath, packageRoot, workspaceRoot },
  };
}

export async function assertDesignArtifactMaturationTarget(
  input: {
    designId: string;
    packageRoot: string;
    workspaceRoot?: string | null;
  },
  deps: DesignArtifactMaturationDeps = DEFAULT_DEPS
): Promise<void> {
  await resolveDesignArtifactMaturationTarget(input, deps);
}

export async function matureDesignArtifactToPlasmidPackage(
  input: {
    designId: string;
    packageRoot: string;
    workspaceRoot?: string | null;
    constructId?: string;
    designName?: string;
    mutationToken?: string;
  },
  deps: DesignArtifactMaturationDeps = DEFAULT_DEPS
): Promise<DesignArtifactMaturationResult> {
  const resolved = await resolveDesignArtifactMaturationTarget(input, deps);
  const packageRoot = normalizePath(input.packageRoot);

  if (resolved.state === 'already-matured') {
    if (input.constructId) {
      await deps.ensureConstructBinding({
        constructId: input.constructId,
        packageRoot,
        name: input.designName ?? input.constructId,
        workspaceRoot: resolved.workspaceRoot,
        designId: input.designId,
        mutationToken: input.mutationToken,
      });
    }
    await deps.retireMirror(input.designId);
    return { state: 'already-matured', packageRoot };
  }

  if (!input.constructId) {
    throw new Error('Publishing a plasmid package requires a construct id.');
  }
  const constructId = input.constructId;

  const workspaceRoot =
    resolved.state === 'ready'
      ? resolved.target.workspaceRoot
      : input.workspaceRoot
        ? normalizePath(input.workspaceRoot)
        : null;
  if (workspaceRoot) {
    await deps.ensureConstructBinding({
      constructId,
      packageRoot,
      name: input.designName ?? constructId,
      workspaceRoot,
      designId: input.designId,
      mutationToken: input.mutationToken,
    });
  }

  if (resolved.state === 'not-file-backed') return resolved;

  const { draftPath } = resolved.target;
  await deps.retireMirror(input.designId);
  try {
    await deps.removeDraft(draftPath, input.mutationToken);
    await deps.markDesignDraftMissing(draftPath);
    return { state: 'matured', draftPath, packageRoot };
  } catch (error) {
    deps.resumeMirror(input.designId);
    throw new Error(
      `Could not retire design working copy "${draftPath}" after publishing construct "${constructId}": ${errorMessage(
        error
      )}`
    );
  }
}
