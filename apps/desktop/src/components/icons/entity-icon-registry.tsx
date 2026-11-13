import { createElement, type ReactNode } from 'react';

import {
  AssemblyTabIcon,
  BiologyFileIcon,
  ChatTabIcon,
  FolderIcon,
  GenomeAssemblyIcon,
  NotebookTabIcon,
  OligoIcon,
  StrainIcon,
  StructureFileIcon,
  MolecularDocumentIcon,
  TextFileIcon,
} from './glyphs';
import { AlignmentIcon, AnnotationsIcon } from './stateful';
import { getTabTypeForFile } from '../../utils/fileTypes';
import type { InlineReferenceTargetType } from '../../shared/inline-reference-ipc';
import type { CatalogRecordPresentationKind } from '../../shared/catalog-entity';

export type EntityIconKind =
  | 'molecular-document'
  | 'notebook'
  | 'sequence'
  | 'annotation'
  | 'alignment'
  | 'primer'
  | 'design'
  | 'protein'
  | 'strain'
  | 'record'
  | 'structure'
  | 'genome'
  | 'chat'
  | 'folder'
  | 'text';

const ALIASES: Readonly<Record<string, EntityIconKind>> = {
  'molecular-document': 'molecular-document',
  page: 'notebook',
  'page-link': 'notebook',
  notebook: 'notebook',
  sequence: 'sequence',
  plasmid: 'sequence',
  sequence_region: 'annotation',
  annotation: 'annotation',
  alignment: 'alignment',
  oligo: 'primer',
  rna_oligo: 'primer',
  primer: 'primer',
  primers: 'primer',
  'dna-oligos': 'primer',
  'rna-oligos': 'primer',
  design: 'design',
  assembly: 'design',
  protein: 'protein',
  proteins: 'protein',
  strain: 'strain',
  record: 'record',
  strains: 'strain',
  'dna-sequences': 'sequence',
  structure: 'structure',
  structure3d: 'structure',
  genome: 'genome',
  chromosome: 'genome',
  'track-view': 'genome',
  chat: 'chat',
  folder: 'folder',
  workspace: 'folder',
  text: 'text',
  file: 'text',
  directory: 'folder',
};

export function canonicalEntityIconKind(raw: string): EntityIconKind | null {
  return ALIASES[raw] ?? null;
}

export function entityIconKindForCatalogPresentation(
  presentationKind: CatalogRecordPresentationKind
): Extract<EntityIconKind, CatalogRecordPresentationKind> {
  switch (presentationKind) {
    case 'strain':
      return 'strain';
    case 'sequence':
      return 'sequence';
    case 'record':
      return 'record';
  }
}

type GlyphComponent = (props: { className?: string }) => ReactNode;

const GLYPHS: Readonly<Record<EntityIconKind, GlyphComponent>> = {
  'molecular-document': MolecularDocumentIcon as GlyphComponent,
  notebook: NotebookTabIcon as GlyphComponent,
  sequence: BiologyFileIcon as GlyphComponent,
  primer: OligoIcon as GlyphComponent,
  annotation: AnnotationsIcon as GlyphComponent,
  alignment: AlignmentIcon as GlyphComponent,
  design: AssemblyTabIcon as GlyphComponent,
  protein: StructureFileIcon as GlyphComponent,
  strain: StrainIcon as GlyphComponent,
  record: TextFileIcon as GlyphComponent,
  structure: StructureFileIcon as GlyphComponent,
  genome: GenomeAssemblyIcon as GlyphComponent,
  chat: ChatTabIcon as GlyphComponent,
  folder: FolderIcon as GlyphComponent,
  text: TextFileIcon as GlyphComponent,
};

export function iconForEntityKind(rawKind: string, className = 'w-4 h-4'): ReactNode | null {
  const kind = canonicalEntityIconKind(rawKind);
  if (!kind) return null;
  return createElement(GLYPHS[kind], { className });
}

export function entityIconKindForWorkspaceTarget(
  path: string,
  targetType: InlineReferenceTargetType
): EntityIconKind {
  if (targetType === 'sequence-package') return 'sequence';
  if (targetType === 'directory') return 'folder';

  switch (getTabTypeForFile(path)) {
    case 'sequence':
      return 'sequence';
    case 'page':
      return 'notebook';
    case 'design':
      return 'design';
    case 'protein':
      return 'protein';
    case 'structure':
      return 'structure';
    default:
      return 'text';
  }
}

export const ENTITY_ICON_KINDS = Object.keys(GLYPHS) as EntityIconKind[];
