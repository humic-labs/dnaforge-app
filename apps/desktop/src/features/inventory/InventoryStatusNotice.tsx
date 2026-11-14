import { Button, Notice } from '../../components/ui';
import type { InventoryController, InventoryControllerState } from './inventory-controller';

export function InventoryStatusNotice({
  controller,
  status,
}: {
  controller: InventoryController;
  status: InventoryControllerState;
}) {
  switch (status.kind) {
    case 'loading':
      return <Notice testId="inventory-loading">Loading inventory…</Notice>;
    case 'submitting':
      return (
        <Notice testId="inventory-submitting">
          {status.stage === 'refreshing'
            ? 'Change saved. Loading the latest inventory…'
            : `Saving ${status.attempt.summary.toLowerCase()}…`}
        </Notice>
      );
    case 'outcome-unknown':
      return (
        <Notice
          tone="warning"
          testId="inventory-outcome-unknown"
          actions={
            <>
              <Button onClick={() => void controller.checkPending()}>Check status</Button>
              <Button onClick={() => void controller.retryPending()}>Retry same change</Button>
            </>
          }
        >
          {status.message}
        </Notice>
      );
    case 'committed-refresh-failed':
      return (
        <Notice
          tone="warning"
          testId="inventory-committed-refresh-failed"
          actions={
            <Button onClick={() => void controller.refresh()}>Reload saved inventory</Button>
          }
        >
          {status.message}
        </Notice>
      );
    case 'conflict':
      return (
        <Notice
          tone="warning"
          testId="inventory-conflict"
          actions={
            <Button
              onClick={() =>
                status.reviewReady ? controller.dismiss() : void controller.refresh()
              }
            >
              {status.reviewReady ? 'Review latest inventory' : 'Refresh inventory'}
            </Button>
          }
        >
          {status.message}
          {status.recoveryError ? ` ${status.recoveryError}` : ''}
        </Notice>
      );
    case 'refused':
      return (
        <Notice
          tone="error"
          testId="inventory-refused"
          actions={
            <Button
              onClick={() =>
                status.data
                  ? controller.dismiss()
                  : status.project
                    ? void controller.refresh()
                    : void controller.initialize()
              }
            >
              {status.data ? 'Edit change' : 'Try again'}
            </Button>
          }
        >
          {status.message}
          {status.recoveryError ? ` ${status.recoveryError}` : ''}
        </Notice>
      );
    default:
      return null;
  }
}
