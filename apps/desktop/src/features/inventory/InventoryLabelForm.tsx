import { useEffect, useMemo, useSyncExternalStore } from 'react';
import { Button, Notice, Select } from '../../components/ui';
import { platform } from '../../platform';
import type {
  InventoryController,
  InventoryControllerState,
  InventoryData,
} from './inventory-controller';
import {
  inventoryLabelOutputPending,
  inventoryLabelSpecificationLocked,
} from './inventory-label-session';
import { InventoryPhysicalDialog } from './InventoryPhysicalDialog';
import { PhysicalField } from './InventoryPhysicalControls';

export function InventoryLabelForm({
  codeId,
  data,
  controller,
  status,
  onClose,
}: {
  codeId: string;
  data: InventoryData;
  controller: InventoryController;
  status: InventoryControllerState;
  onClose(): void;
}) {
  const project = data.project.projectId;
  const inventoryId = data.project.defaultInventoryId;
  const session = useMemo(
    () =>
      controller.labelSession(
        { project, inventoryId, codeId },
        {
          chooseDestination: (defaultPath) =>
            platform().dialog.save({
              defaultPath,
              filters: [{ name: 'Inventory label SVG', extensions: ['svg'] }],
            }),
          write: (path, content) => platform().fs.writeTextFileAtomic({ path, content }),
          read: (path) => platform().fs.readTextFile(path),
        }
      ),
    [controller, project, inventoryId, codeId]
  );
  useEffect(() => () => session.cancelChoosing(), [session]);
  const { mediaProfileId, preparation, output } = useSyncExternalStore(
    session.subscribe,
    session.getSnapshot
  );
  const artifact = preparation.kind === 'rendered' ? preparation.artifact : undefined;
  const image = useMemo(
    () =>
      artifact
        ? `data:image/svg+xml;charset=utf-8,${encodeURIComponent(artifact.rendered.svg)}`
        : undefined,
    [artifact]
  );
  const code = data.state.itemCodes[codeId];
  const item = code?.item;
  const record = item
    ? item.kind === 'storage'
      ? data.state.storage[item.id]
      : data.state.vessels[item.id]
    : undefined;
  const mayRender = code?.lifecycle.kind === 'active' && record?.lifecycle === 'active';
  const locked = inventoryLabelSpecificationLocked(output);
  const pending = inventoryLabelOutputPending(output);
  const retainedPath = 'path' in output ? output.path : undefined;
  const needsConfirmation = output.kind === 'output-unconfirmed' || output.kind === 'failed';
  return (
    <InventoryPhysicalDialog
      title="Create label"
      subtitle={data.project.name}
      controller={controller}
      status={status}
      onClose={onClose}
    >
      <div
        data-testid="inventory-label-form"
        data-label-state={preparation.kind}
        data-code-id={codeId}
        data-artifact-sha256={artifact?.svgSha256}
        className="space-y-4 text-sm"
      >
        <p className="break-all text-xs text-fg-muted">
          Project {project} · Inventory {inventoryId}
        </p>
        <p>
          This QR symbol contains the exact code value. Looking it up still requires the namespace
          and inventory context. The label includes the namespace and full item ID.
        </p>
        {code ? (
          <div className="space-y-1 break-all text-xs">
            <p>
              Namespace: <code>{JSON.stringify(code.namespace)}</code>
            </p>
            <p>
              Exact code: <code className="whitespace-pre-wrap">{JSON.stringify(code.value)}</code>
            </p>
            <p>
              Item: {code.item.kind}:{code.item.id}
            </p>
          </div>
        ) : null}
        {!mayRender ? (
          <Notice tone="error">
            A new label requires an active code and active physical item. Retained labels below keep
            their original snapshot.
          </Notice>
        ) : null}
        <PhysicalField label="Label size">
          <Select
            ariaLabel="Label size"
            value={mediaProfileId}
            disabled={locked}
            options={[
              { value: 'qr-50x30-300dpi', label: '50 × 30 mm · 300 dpi' },
              { value: 'qr-80x50-300dpi', label: '80 × 50 mm · 300 dpi' },
            ]}
            onValueChange={(value) => {
              if (value === 'qr-50x30-300dpi' || value === 'qr-80x50-300dpi')
                session.selectMedia(value);
            }}
          />
        </PhysicalField>
        <p className="text-xs text-fg-muted">
          One QR template, four dots per module and a four-module quiet zone. Item names are not
          included. Printer scaling, label stock and physical scanning need separate checks.
        </p>
        <Button
          disabled={!mayRender || locked || preparation.kind === 'rendering'}
          onClick={() => void session.prepare()}
        >
          {preparation.kind === 'rendering' ? 'Rendering…' : 'Render label'}
        </Button>
        {preparation.kind === 'failed' ? (
          <Notice tone="error" testId="inventory-label-render-error">
            {preparation.message}
          </Notice>
        ) : null}
        {artifact ? (
          <section className="space-y-3 rounded border border-border p-3">
            <h3 className="font-semibold" role="status">
              Rendered
            </h3>
            <p className="break-all text-xs" data-testid="inventory-label-source">
              Snapshot from revision {artifact.sourceRevision} · {artifact.binding.item.kind}:
              {artifact.binding.item.id}
            </p>
            {artifact.sourceRevision !== data.state.revision ? (
              <Notice>
                Inventory is now at revision {data.state.revision}. This label retains revision{' '}
                {artifact.sourceRevision}; its bytes have not changed. Current code is{' '}
                {code?.lifecycle.kind ?? 'unavailable'} and item is{' '}
                {record?.lifecycle ?? 'unavailable'}.
              </Notice>
            ) : null}
            <img
              data-testid="inventory-label-preview"
              data-artifact-sha256={artifact.svgSha256}
              src={image}
              alt={`QR label for ${artifact.binding.item.kind}:${artifact.binding.item.id}`}
              className="max-w-full border border-border bg-white"
              style={{ width: `${artifact.rendered.media.widthMm}mm`, imageRendering: 'pixelated' }}
            />
            <p className="text-xs text-fg-muted">
              {artifact.rendered.media.widthMm} × {artifact.rendered.media.heightMm} mm ·{' '}
              {artifact.rendered.media.dpi} dpi · {artifact.rendered.symbol.modules} QR modules
            </p>
            <p className="break-all text-xs" data-testid="inventory-label-hash">
              {artifact.svgSha256}
            </p>
            <p className="text-xs text-fg-muted">
              This preview is rendered software output. Exporting saves an SVG; it does not print or
              attach a label, or establish that hardware can scan it.
            </p>
            <Button disabled={locked} onClick={() => void session.exportLabel()}>
              Export label SVG
            </Button>
          </section>
        ) : null}
        <section
          data-testid="inventory-label-export"
          data-export-state={output.kind}
          data-artifact-sha256={'artifact' in output ? output.artifact.svgSha256 : undefined}
          className="space-y-2 text-xs"
          aria-live="polite"
        >
          <p className="font-medium">
            {output.kind === 'not-exported'
              ? 'Not exported'
              : output.kind === 'choosing'
                ? 'Choosing destination…'
                : output.kind === 'writing'
                  ? 'Writing SVG…'
                  : output.kind === 'confirming'
                    ? 'Checking saved bytes…'
                    : output.kind === 'exported'
                      ? 'Exported. Saved bytes match this label.'
                      : output.kind === 'output-unconfirmed'
                        ? 'Output unconfirmed'
                        : 'Export failed'}
          </p>
          {retainedPath ? (
            <p className="break-all" data-testid="inventory-label-destination">
              {retainedPath}
            </p>
          ) : null}
          {needsConfirmation ? (
            <Notice tone="error">
              {output.message}
              {output.kind === 'output-unconfirmed'
                ? ' A file may exist. This exact label and destination are retained while the app is open.'
                : ''}
            </Notice>
          ) : null}
          {needsConfirmation && retainedPath ? (
            <div className="flex flex-wrap gap-2">
              <Button onClick={() => void session.checkOutput()}>Check saved file</Button>
              <Button onClick={() => void session.retryOutput()}>Retry same export</Button>
            </div>
          ) : null}
          {needsConfirmation ? (
            <>
              <Button onClick={() => session.forgetOutput()}>Forget export attempt</Button>
              <p className="text-fg-muted">
                Retrying writes the retained SVG to the same destination. Forgetting leaves any
                existing file unchanged and allows a new label or destination.
              </p>
            </>
          ) : null}
          {pending ? (
            <p className="text-fg-muted">
              Closing this view keeps this attempt with its original code. Reopen that code to see
              the result.
            </p>
          ) : null}
        </section>
      </div>
    </InventoryPhysicalDialog>
  );
}
