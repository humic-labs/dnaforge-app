import { useTranslationDialogStore } from '../translation-dialog-store';
import { CopyTranslationDialog } from './CopyTranslationDialog';

export function TranslationDialogHost() {
  const request = useTranslationDialogStore((s) => s.request);
  const close = useTranslationDialogStore((s) => s.close);
  const requestRevision = useTranslationDialogStore((s) => s.requestRevision);

  if (!request) return null;

  return (
    <CopyTranslationDialog
      key={requestRevision}
      sequence={request.sequence}
      label={request.label}
      geneticCode={request.geneticCode}
      onClose={close}
    />
  );
}
