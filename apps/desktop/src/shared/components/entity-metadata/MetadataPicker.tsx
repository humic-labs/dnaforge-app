import type { ComponentProps } from 'react';
import { Select } from '../../../components/ui';

export function MetadataPicker({
  ariaLabel,
  searchLabel = `Search ${ariaLabel.toLowerCase()}`,
  ...props
}: Omit<ComponentProps<typeof Select>, 'searchable'>) {
  return <Select {...props} ariaLabel={ariaLabel} searchLabel={searchLabel} searchable />;
}
