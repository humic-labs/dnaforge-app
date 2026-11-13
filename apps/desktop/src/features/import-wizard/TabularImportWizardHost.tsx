import { TabularImportWizard } from './TabularImportWizard';
import { useTabularImportStore } from './tabular-import-store';

export function TabularImportWizardHost() {
  const request = useTabularImportStore((s) => s.request);
  const resolveCurrent = useTabularImportStore((s) => s.resolveCurrent);

  if (!request) return null;

  return (
    <TabularImportWizard
      entries={request.entries}
      onConfirm={(entries) => resolveCurrent(entries)}
      onCancel={() => resolveCurrent(null)}
    />
  );
}
