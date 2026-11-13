import type { ComponentProps } from 'react';
import { Button } from '../../components/ui';

export function MetadataSaveButton({
  hasChanges,
  disabled,
  ...props
}: Omit<ComponentProps<typeof Button>, 'variant'> & { hasChanges: boolean }) {
  return (
    <Button
      {...props}
      variant={hasChanges ? 'primary' : 'secondary'}
      disabled={disabled || !hasChanges}
    />
  );
}
