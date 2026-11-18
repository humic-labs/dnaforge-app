import type { FileIconCategory } from '../../utils/fileTypes';
import type { IconProps } from './types';
import { iconForEntityKind } from './entity-icon-registry';
import { entityColorFamily, type EntityColorContext } from '../../shared/entity-color-family';

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
  const kind =
    category === 'biology' && entityColorFamily(colorContext) === 'protein' ? 'protein' : category;
  return <>{iconForEntityKind(kind, className, colorContext, size)}</>;
}
