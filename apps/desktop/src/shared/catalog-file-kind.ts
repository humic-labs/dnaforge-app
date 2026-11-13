import { isComputeRecoveryBackingPath } from './compute-result-path';
import { isForgePackageMetaPath } from './forge-package-path';
import {
  ENTITY_RECORD_ARTIFACT_SUFFIX,
  MOLECULAR_DOCUMENT_FILE_SUFFIX,
} from './registry-file-types';
import { scientificPackageKindForMetaPath } from './scientific-package';

export const TEXT_SEQUENCE_FILE_KINDS = ['genbank', 'fasta', 'fastq'] as const;

export function isTextSequenceFileKind(fileKind: string): boolean {
  return (TEXT_SEQUENCE_FILE_KINDS as readonly string[]).includes(fileKind);
}

const GENBANK_EXTENSIONS = new Set(['gb', 'gbk', 'gbff', 'genbank']);
const FASTA_EXTENSIONS = new Set(['fa', 'fasta', 'fna', 'ffn', 'faa']);
const FASTQ_EXTENSIONS = new Set(['fq', 'fastq']);
const TRACE_EXTENSIONS = new Set(['ab1', 'scf']);
const ALIGNMENT_EXTENSIONS = new Set(['sam', 'bam', 'cram', 'aln', 'clustal', 'maf']);
const MMCIF_EXTENSIONS = new Set(['cif', 'mmcif', 'mcif']);

const NOTEBOOK_PACKAGE_META_NAME = 'notebook.json';
const PLASMID_PACKAGE_META_NAME = 'plasmid.json';

function basename(filePath: string): string {
  const separator = Math.max(filePath.lastIndexOf('/'), filePath.lastIndexOf('\\'));
  return separator >= 0 ? filePath.slice(separator + 1) : filePath;
}

export function isPrimerArtifactPath(filePath: string): boolean {
  return basename(filePath).toLowerCase().endsWith('.primer.json');
}

const MANAGED_DISCOVERY_EXCLUDED_DIRECTORIES = new Set([
  '.git',
  '.venv',
  '.waypoint',
  'node_modules',
  'dist',
  'dist-electron',
]);

function hasManagedDiscoveryExcludedDirectory(relPath: string): boolean {
  if (isComputeRecoveryBackingPath(relPath)) return true;
  const normalized = relPath.replace(/\\/g, '/');
  let segmentStart = 0;
  for (let index = 0; index < normalized.length; index++) {
    if (normalized.charCodeAt(index) !== 47) continue;
    if (MANAGED_DISCOVERY_EXCLUDED_DIRECTORIES.has(normalized.slice(segmentStart, index))) {
      return true;
    }
    segmentStart = index + 1;
  }
  return false;
}

export function isManagedPrimerArtifactPath(relPath: string): boolean {
  return isPrimerArtifactPath(relPath) && !hasManagedDiscoveryExcludedDirectory(relPath);
}

export function inferCatalogFileKind(filePath: string): string {
  const lowerName = basename(filePath).toLowerCase();
  if (lowerName.endsWith(MOLECULAR_DOCUMENT_FILE_SUFFIX)) return 'dnaforge-molecular-document';
  if (lowerName.endsWith(ENTITY_RECORD_ARTIFACT_SUFFIX)) return 'waypoint-entity';
  if (lowerName.endsWith('.wpnote.json')) return 'waypoint-notebook';
  if (lowerName.endsWith('.wpdesign.json')) return 'waypoint-design';
  if (lowerName.endsWith('.wpselection.json')) return 'waypoint-residue-selection';
  if (
    lowerName === NOTEBOOK_PACKAGE_META_NAME &&
    isForgePackageMetaPath(filePath, NOTEBOOK_PACKAGE_META_NAME)
  ) {
    return 'waypoint-notebook';
  }
  if (
    lowerName === PLASMID_PACKAGE_META_NAME &&
    isForgePackageMetaPath(filePath, PLASMID_PACKAGE_META_NAME)
  ) {
    return 'waypoint-sequence';
  }
  const scientificPackageKind = scientificPackageKindForMetaPath(filePath);
  if (scientificPackageKind === 'protocol') return 'waypoint-protocol';
  if (scientificPackageKind === 'protocol-run') return 'waypoint-protocol-run';

  const extensionStart = lowerName.lastIndexOf('.');
  const extension = extensionStart >= 0 ? lowerName.slice(extensionStart + 1) : undefined;
  if (!extension) return 'file';

  if (GENBANK_EXTENSIONS.has(extension)) return 'genbank';
  if (FASTA_EXTENSIONS.has(extension)) return 'fasta';
  if (FASTQ_EXTENSIONS.has(extension)) return 'fastq';
  if (TRACE_EXTENSIONS.has(extension)) return 'trace';
  if (ALIGNMENT_EXTENSIONS.has(extension)) return 'alignment';
  if (extension === 'pdb') return 'pdb';
  if (MMCIF_EXTENSIONS.has(extension)) return 'mmcif';
  if (extension === 'bcif') return 'binary-cif';
  return extension;
}

const MANAGED_CATALOG_HEAD_KINDS = new Set([
  'dnaforge-molecular-document',
  'genbank',
  'fasta',
  'fastq',
  'trace',
  'alignment',
  'pdb',
  'mmcif',
  'binary-cif',
  'waypoint-notebook',
  'waypoint-design',
  'waypoint-residue-selection',
  'waypoint-plasmid',
  'waypoint-entity',
  'waypoint-sequence',
  'waypoint-protocol',
  'waypoint-protocol-run',
]);

export function isManagedCatalogHeadCandidate(relPath: string): boolean {
  if (isComputeRecoveryBackingPath(relPath)) return false;
  return (
    isManagedPrimerArtifactPath(relPath) ||
    MANAGED_CATALOG_HEAD_KINDS.has(inferCatalogFileKind(relPath))
  );
}

export function isManagedEntityArtifactPath(relPath: string, kind: string): boolean {
  if (
    kind !== 'waypoint-notebook' &&
    kind !== 'waypoint-design' &&
    kind !== 'waypoint-entity' &&
    kind !== 'waypoint-sequence'
  ) {
    return false;
  }
  if (hasManagedDiscoveryExcludedDirectory(relPath)) return false;
  const normalized = relPath.replace(/\\/g, '/');
  const segments = normalized.split('/');
  return segments.every((segment) => !segment.startsWith('.') || segment === '.forge');
}

export function isVisibleManagedHeadFile(relPath: string): boolean {
  const normalized = relPath.replace(/\\/g, '/');
  let segmentStart = 0;
  for (let index = 0; index <= normalized.length; index++) {
    if (index !== normalized.length && normalized.charCodeAt(index) !== 47) continue;
    if (normalized.charCodeAt(segmentStart) === 46) return false;
    segmentStart = index + 1;
  }
  const separator = normalized.lastIndexOf('/');
  return !normalized
    .slice(separator + 1)
    .toLowerCase()
    .endsWith('.waypoint.json');
}
