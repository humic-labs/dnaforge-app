import { SEQUENCE_PACKAGE_META_NAME, SEQUENCE_PRODUCT_EXTENSIONS } from './sequence-package';
import { NOTEBOOK_PACKAGE_META_NAME } from './notebook-package';
import { FORGE_PACKAGE_MARKER_DIR } from './forge-package';

export type WorkspaceContentForm = 'package' | 'file';

export interface WorkspaceContentKindSpec {
  readonly kind: string;
  readonly form: WorkspaceContentForm;
  readonly extensions: readonly string[];
  readonly markerFile?: string;
  readonly rationale: string;
}

export const WORKSPACE_CONTENT_KINDS: readonly WorkspaceContentKindSpec[] = [
  {
    kind: 'sequence',
    form: 'package',
    extensions: SEQUENCE_PRODUCT_EXTENSIONS,
    markerFile: SEQUENCE_PACKAGE_META_NAME,
    rationale:
      'A construct is a sequence plus a versioned member list (build record, ' +
      'generated primers, attached reads). A loose .gb has nowhere to keep any of ' +
      'that, so renaming it orphans the provenance. Layout changes go through ' +
      'sequence-package-contract.ts with a migrator — never a new folder per kind.',
  },
  {
    kind: 'notebook',
    form: 'package',
    extensions: ['.md'],
    markerFile: NOTEBOOK_PACKAGE_META_NAME,
    rationale:
      'An entry is a rich document plus a Markdown projection that external tools ' +
      'read. Two files that must travel together, so they get a container.',
  },
  {
    kind: 'primer',
    form: 'file',
    extensions: ['.primer.json'],
    rationale: 'A primer artifact is self-contained; it has no members to keep together.',
  },
  {
    kind: 'design',
    form: 'file',
    extensions: ['.wpdesign.json'],
    rationale: 'A design draft is a single document that matures into a plasmid package.',
  },
] as const;

export const UNMANAGED_BY_DESIGN =
  'Any path matching no kind below is unmanaged user content and is always legal.';

export function kindForPath(relativePath: string): WorkspaceContentKindSpec | null {
  const lower = relativePath.toLowerCase();
  const byLength = [...WORKSPACE_CONTENT_KINDS].sort(
    (a, b) =>
      Math.max(...b.extensions.map((e) => e.length)) -
      Math.max(...a.extensions.map((e) => e.length))
  );
  for (const spec of byLength) {
    if (spec.extensions.some((ext) => lower.endsWith(ext))) return spec;
  }
  return null;
}

export interface ManifestViolation {
  readonly path: string;
  readonly kind: string;
  readonly expected: WorkspaceContentForm;
  readonly reason: string;
}

export const PAIRED_SIDECAR_SUFFIXES = ['.waypoint.json'] as const;

export function hasPairedSidecar(fileName: string, siblingNames: readonly string[]): boolean {
  return PAIRED_SIDECAR_SUFFIXES.some((suffix) => siblingNames.includes(`${fileName}${suffix}`));
}

export function violationForPath(input: {
  relativePath: string;
  insidePackage: boolean;
  siblingNames?: readonly string[];
}): ManifestViolation | null {
  const { relativePath, insidePackage } = input;

  if (relativePath.split('/').includes(FORGE_PACKAGE_MARKER_DIR)) return null;

  const spec = kindForPath(relativePath);
  if (!spec) return null;

  if (spec.form === 'file') return null;

  const fileName = relativePath.split('/').pop() ?? relativePath;
  if (input.siblingNames && hasPairedSidecar(fileName, input.siblingNames)) return null;

  if (!insidePackage) {
    return {
      path: relativePath,
      kind: spec.kind,
      expected: 'package',
      reason:
        `a ${spec.kind} must be a package (<name>/<name>${spec.extensions[0]} plus ` +
        `.forge/${spec.markerFile}), not a loose file. ${spec.rationale}`,
    };
  }
  return null;
}
