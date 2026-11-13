import { platform } from '../../platform';
import { ImportWizardModal } from './ImportWizardModal';
import { useImportWizardStore } from './import-wizard-store';

export function ImportWizardHost() {
  const request = useImportWizardStore((s) => s.request);
  const resolveCurrent = useImportWizardStore((s) => s.resolveCurrent);

  if (!request) return null;

  return (
    <ImportWizardModal
      key={request.id}
      requestId={request.id}
      initial={request.initial}
      onConfirm={(outcome) => resolveCurrent(outcome, request.id)}
      onCancel={() => resolveCurrent(null, request.id)}
      previewSequenceImport={(input) => platform().workspace.previewSequenceImport(input)}
    />
  );
}
