import { useOversizedDialogStore } from '../oversized-dialog-store';
import { OversizedFileDialog } from '../../canvas/public/components/load-states/OversizedFileDialog';
import { OversizedFileBlock } from '../../canvas/public/components/load-states/OversizedFileBlock';

function basename(path: string): string {
  return path.split('/').pop() || path;
}

export function OversizedDialogHost() {
  const request = useOversizedDialogStore((s) => s.request);
  const resolveCurrent = useOversizedDialogStore((s) => s.resolveCurrent);

  if (!request) return null;

  if (request.kind === 'warn') {
    return (
      <OversizedFileDialog
        fileName={basename(request.filePath)}
        sizeBytes={request.sizeBytes}
        onConfirm={() => resolveCurrent(true)}
        onCancel={() => resolveCurrent(false)}
      />
    );
  }

  return (
    <OversizedFileBlock
      fileName={basename(request.filePath)}
      sizeBytes={request.sizeBytes}
      onDismiss={() => resolveCurrent(false)}
    />
  );
}
