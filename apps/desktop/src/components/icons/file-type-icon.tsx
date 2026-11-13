import type { FileIconCategory } from '../../utils/fileTypes';
import type { IconProps } from './types';
import { iconForEntityKind } from './entity-icon-registry';
import {
  ArchiveFileIcon,
  BiologyFileIcon,
  CodeFileIcon,
  GenericFileIcon,
  GenomeAssemblyIcon,
  ImageFileIcon,
  PdfFileIcon,
  SpreadsheetFileIcon,
  StructureFileIcon,
  MolecularDocumentIcon,
  TextFileIcon,
  WebFileIcon,
} from './glyphs';

interface FileTypeIconProps extends IconProps {
  category: FileIconCategory;
}

export function FileTypeIcon({ category, className, size }: FileTypeIconProps) {
  switch (category) {
    case 'design':
      return <>{iconForEntityKind(category, className)}</>;
    case 'molecular-document':
      return <MolecularDocumentIcon className={className} />;
    case 'genome':
      return <GenomeAssemblyIcon className={className} />;
    case 'structure':
      return <StructureFileIcon className={className} />;
    case 'biology':
      return <BiologyFileIcon size={size} className={className ?? 'w-4 h-4 flex-shrink-0'} />;
    case 'web':
      return <WebFileIcon className={className} />;
    case 'image':
      return <ImageFileIcon className={className} />;
    case 'pdf':
      return <PdfFileIcon className={className} />;
    case 'archive':
      return <ArchiveFileIcon className={className} />;
    case 'spreadsheet':
      return <SpreadsheetFileIcon className={className} />;
    case 'code':
      return <CodeFileIcon className={className} />;
    case 'text':
      return <TextFileIcon className={className} />;
    case 'generic':
      return <GenericFileIcon className={className} />;
    default: {
      const _exhaustive: never = category;
      void _exhaustive;
      return <GenericFileIcon className={className} />;
    }
  }
}
