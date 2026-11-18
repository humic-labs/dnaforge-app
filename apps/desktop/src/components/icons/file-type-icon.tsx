import type { FileIconCategory } from '../../utils/fileTypes';
import type { IconProps } from './types';
import { iconForEntityKind } from './entity-icon-registry';
import { BiologyFileIcon } from './glyphs';
import {
  entityColorFamily,
  entityIconClassName,
  type EntityColorContext,
} from '../../shared/entity-color-family';

interface FileTypeIconProps extends IconProps {
  category: FileIconCategory;
  path?: string;
  molecule?: string;
  context?: EntityColorContext;
}

export function FileTypeIcon({
  category,
  className = 'w-4 h-4 flex-shrink-0',
  size,
  path,
  molecule,
  context,
}: FileTypeIconProps) {
  const sourcePath = context?.path ?? path;
  const colorContext = {
    kind:
      category === 'genome' && sourcePath?.toLowerCase().endsWith('.dnaforge-track-view.json')
        ? 'track-view'
        : category,
    path,
    molecule,
    ...context,
  };
  if (category === 'biology') {
    if (entityColorFamily(colorContext) === 'protein')
      return <>{iconForEntityKind('protein', className, colorContext)}</>;
    return <BiologyFileIcon size={size} className={entityIconClassName(colorContext, className)} />;
  }
  return <>{iconForEntityKind(category, className, colorContext)}</>;
}
