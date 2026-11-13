import { forwardRef } from 'react';
import {
  WorkspaceFolderPicker,
  type WorkspaceFolderPickerHandle,
  type WorkspaceFolderPickerProps,
} from '../../../components/WorkspaceFolderPicker';

export type AssemblySaveLocationPickerHandle = WorkspaceFolderPickerHandle;

type AssemblySaveLocationPickerProps = Pick<
  WorkspaceFolderPickerProps,
  'roots' | 'initialDir' | 'selectedDir' | 'onSelectFolder'
>;

export const AssemblySaveLocationPicker = forwardRef<
  AssemblySaveLocationPickerHandle,
  AssemblySaveLocationPickerProps
>(function AssemblySaveLocationPicker(props, ref) {
  return (
    <WorkspaceFolderPicker
      ref={ref}
      {...props}
      foldersOnly
      idPrefix="assembly-picker"
      containerTestId="assembly-save-location-picker"
    />
  );
});
