import {
  entityTypeIconKind,
  type EntityTypeIconKind,
} from '@waypoint/scientific-artifacts/shared/entity-types';
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
  ArchiveFileIcon,
  CodeFileIcon,
  GenericFileIcon,
  ImageFileIcon,
  PdfFileIcon,
  SpreadsheetFileIcon,
  WebFileIcon,
} from './glyphs';
import { AlignmentIcon, AnnotationsIcon } from './stateful';
import { getFileIconCategory, getTabTypeForFile } from '../../utils/fileTypes';
import type { InlineReferenceTargetType } from '../../shared/inline-reference-ipc';
import type { CatalogRecordPresentationKind } from '../../shared/catalog-entity';
import { entityColorFamily, type EntityColorContext } from '../../shared/entity-color-family';
import type { IconProps } from './types';

export type EntityIconKind =
  | EntityTypeIconKind
  | 'image'
  | 'pdf'
  | 'archive'
  | 'code'
  | 'web'
  | 'generic';

const VISUAL_ALIASES: Readonly<Record<string, EntityIconKind>> = {
  biology: 'sequence',
  rna: 'sequence',
  dna: 'sequence',
  primers: 'primer',
  'dna-oligos': 'primer',
  'rna-oligos': 'primer',
  assembly: 'design',
  'assembly-panel': 'design',
  'assembly-browser': 'design',
  'adjacency-graph': 'design',
  proteins: 'protein',
  protein_sequence: 'protein',
  strains: 'strain',
  'dna-sequences': 'sequence',
  structure3d: 'structure',
  'protocol-run': 'notebook',
  'scientific-document': 'notebook',
  workspace: 'folder',
  spreadsheet: 'table',
  config: 'code',
  html: 'web',
};

export function canonicalEntityIconKind(raw: string): EntityIconKind | null {
  return (
    entityTypeIconKind(raw) ??
    (Object.hasOwn(GLYPHS, raw) ? (raw as EntityIconKind) : null) ??
    (Object.hasOwn(VISUAL_ALIASES, raw) ? VISUAL_ALIASES[raw] : null)
  );
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

type GlyphComponent = (props: IconProps) => ReactNode;

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
  table: SpreadsheetFileIcon as GlyphComponent,
  image: ImageFileIcon as GlyphComponent,
  pdf: PdfFileIcon as GlyphComponent,
  archive: ArchiveFileIcon as GlyphComponent,
  code: CodeFileIcon as GlyphComponent,
  web: WebFileIcon as GlyphComponent,
  generic: GenericFileIcon as GlyphComponent,
};

export function referenceIconPresentation(entity: {
  type: string;
  iconKind: string;
  namedTypeKey?: string;
  registryKind?: string | null;
  path?: string | null;
  iconContext?: EntityColorContext;
}): { kind: string; context: EntityColorContext } {
  const namedKind = entity.namedTypeKey?.startsWith('type:')
    ? entity.namedTypeKey.slice(5)
    : undefined;
  const path = entity.iconContext?.path ?? entity.path ?? undefined;
  const genericFile =
    namedKind === 'file' ||
    (!entity.namedTypeKey && entity.type === 'file' && entity.iconKind === 'text');
  const fileCategory = genericFile && path ? getFileIconCategory(path) : undefined;
  const visualFileCategory =
    fileCategory &&
    ['image', 'pdf', 'archive', 'code', 'web', 'spreadsheet', 'generic', 'text'].includes(
      fileCategory
    );
  return {
    kind: visualFileCategory ? fileCategory : entity.iconKind,
    context: {
      path,
      ...entity.iconContext,
      kind: entity.iconContext?.kind ?? entity.registryKind ?? namedKind ?? entity.type,
    },
  };
}

export function iconForEntityKind(
  rawKind: string,
  className = 'w-4 h-4',
  context: EntityColorContext = {},
  size?: number
): ReactNode | null {
  const kind = canonicalEntityIconKind(rawKind);
  if (!kind) return null;
  return createElement(GLYPHS[kind], {
    className,
    size,
    colorFamily: entityColorFamily({ ...context, kind: context.kind ?? rawKind }),
  });
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
