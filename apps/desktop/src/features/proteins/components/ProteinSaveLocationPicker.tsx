import {
  WorkspaceFolderPicker,
  type WorkspaceFolderPickerProps,
} from '../../../components/WorkspaceFolderPicker';

type ProteinSaveLocationPickerProps = Pick<
  WorkspaceFolderPickerProps,
  'roots' | 'initialDir' | 'selectedDir' | 'onSelectFolder'
>;

export function ProteinSaveLocationPicker(props: ProteinSaveLocationPickerProps) {
  return (
    <WorkspaceFolderPicker
      {...props}
      idPrefix="protein-picker"
      containerTestId="protein-save-location-picker"
    />
  );
}
