import { forwardRef, type ComponentPropsWithoutRef } from 'react';
import { FolderIcon } from '../../components/icons';
import { MenuTrigger } from '@waypoint/ui-components';

export const ImportDestinationField = forwardRef<
  HTMLButtonElement,
  Omit<ComponentPropsWithoutRef<'button'>, 'children' | 'className' | 'style'> & {
    label: string;
    open: boolean;
  }
>(function ImportDestinationField({ label, open, ...props }, ref) {
  return (
    <MenuTrigger
      {...props}
      ref={ref}
      type="button"
      aria-haspopup="dialog"
      open={open}
      density="form"
      icon={<FolderIcon className="text-fg-subtle" />}
    >
      {label}
    </MenuTrigger>
  );
});
