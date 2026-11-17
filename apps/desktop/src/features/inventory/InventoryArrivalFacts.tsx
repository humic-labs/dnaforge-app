import { useEffect, useRef, useState } from 'react';
import type {
  InventoryArrival,
  InventoryArrivalDocumentRead,
  InventoryArrivalRecordedSupplierClaim,
} from '@waypoint/domain-services';
import { Button, Notice, TextArea } from '../../components/ui';
import type { InventoryClient } from '../../shared/inventory-client';
import type { InventoryData } from './inventory-controller';
import { inventoryAmountLabel } from './inventory-view';

function claimValue(claim: InventoryArrivalRecordedSupplierClaim['claim']): string {
  switch (claim.kind) {
    case 'quantity':
      return `Quantity: ${claim.valueLexeme} ${claim.unitText}`;
    case 'supplier-qc':
      return `Supplier quality result: ${claim.resultText}`;
    case 'identifier':
      return `${claim.role === 'product' ? 'Product' : claim.role === 'packaging-batch' ? 'Packaging batch' : 'Component batch'}: ${claim.value}`;
    case 'date-or-condition':
      return `Supplier date or condition: ${claim.text}`;
  }
}

function claimSubject(
  arrival: InventoryArrival,
  subject: InventoryArrivalRecordedSupplierClaim['subject']
): string {
  if (subject.kind === 'delivery') return 'This delivery';
  if (subject.kind === 'package')
    return `Package: ${arrival.packages.find((item) => item.key === subject.packageKey)?.label ?? subject.packageKey}`;
  return `Component: ${arrival.components.find((item) => item.key === subject.componentKey)?.label ?? subject.componentKey}`;
}

export function InventoryArrivalFacts({
  arrival,
  data,
  client,
}: {
  arrival: InventoryArrival;
  data: InventoryData;
  client: InventoryClient;
}) {
  const [document, setDocument] = useState<InventoryArrivalDocumentRead | null>(null);
  const [failed, setFailed] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [download, setDownload] = useState<{ url: string; name: string } | null>(null);
  const scope = `${data.project.projectId}:${data.project.defaultInventoryId}:${arrival.id}`;
  const scopeRef = useRef(scope);
  scopeRef.current = scope;
  useEffect(() => {
    setDocument(null);
    setFailed(null);
    setPending(false);
  }, [scope]);
  useEffect(() => {
    setDownload(null);
    if (document?.kind !== 'available' || document.arrivalId !== arrival.id) return;
    try {
      const bytes =
        document.body.encoding === 'utf8'
          ? new TextEncoder().encode(document.body.value)
          : Uint8Array.from(atob(document.body.value), (character) => character.charCodeAt(0));
      const url = URL.createObjectURL(new Blob([bytes], { type: document.document.mediaType }));
      const extension = {
        'application/pdf': 'pdf',
        'application/json': 'json',
        'text/csv': 'csv',
        'text/plain': 'txt',
      }[document.document.mediaType];
      setDownload({ url, name: `${document.document.key}.${extension}` });
      return () => URL.revokeObjectURL(url);
    } catch {
      setFailed('The retained document could not be prepared for download.');
    }
  }, [document, arrival.id, scope]);
  async function readDocument(key: string) {
    const source = arrival.documents.find((item) => item.key === key);
    if (!source) return;
    setPending(true);
    setFailed(null);
    try {
      const result = await client.arrivalDocument({
        project: data.project.projectId,
        inventoryId: data.project.defaultInventoryId,
        arrivalId: arrival.id,
        documentKey: key,
        expectedSha256: source.sha256,
      });
      if (scopeRef.current === scope) setDocument(result);
    } catch (cause) {
      if (scopeRef.current === scope)
        setFailed(
          cause instanceof Error ? cause.message : 'The original document could not be read.'
        );
    } finally {
      if (scopeRef.current === scope) setPending(false);
    }
  }
  return (
    <section
      className="space-y-3"
      data-testid="inventory-arrival-facts"
      data-arrival-id={arrival.id}
    >
      <p className="break-all text-xs">
        Delivery: {arrival.identity.namespace} / {arrival.identity.arrivalId}
      </p>
      <p>Supplier: {arrival.supplier ?? 'Unknown'}</p>
      <p className="text-xs">
        Recorded {new Date(arrival.at).toISOString()} ·{' '}
        {arrival.by.kind === 'imported' ? 'Imported arrival evidence' : 'Local arrival record'}
      </p>
      <p className="text-xs">
        Observed scope: {arrival.scope.kind} · {arrival.scope.reason}
      </p>
      {arrival.packages.map((item) => (
        <p key={item.key} className="text-xs">
          Package: {item.label} · Packaging batch: {item.packagingBatch ?? 'Unrecorded'}
        </p>
      ))}
      {arrival.components.map((component) => {
        const stock = component.target.stockId ? data.state.stocks[component.target.stockId] : null;
        return (
          <article
            key={component.key}
            className="space-y-1 rounded border border-border p-3"
            data-arrival-component={component.key}
          >
            <h4 className="text-sm font-semibold">{component.label}</h4>
            <p className="text-xs">
              Disposition: {component.choice.kind} · Component batch:{' '}
              {component.componentBatch ?? 'Unrecorded'}
            </p>
            {component.receivedQuantity ? (
              <p data-original-received-quantity>
                Original received amount: {inventoryAmountLabel(component.receivedQuantity)}
              </p>
            ) : null}
            {stock ? (
              <p data-current-remaining-quantity>
                Current remaining amount: {inventoryAmountLabel(stock.quantity)}
              </p>
            ) : null}
            {stock ? (
              <p className="text-xs">
                Current stock quality: {stock.quality} · Current container:{' '}
                {data.state.vessels[stock.vesselId]?.name ?? stock.vesselId}
              </p>
            ) : null}
          </article>
        );
      })}
      {arrival.claims.length ? (
        <section className="space-y-3" aria-label="Recorded supplier evidence">
          <h4 className="text-sm font-semibold">Recorded supplier evidence</h4>
          <p className="text-xs">
            These supplier statements do not set local quality, lot assessment or expiry.
          </p>
          {arrival.claims.map((claim) => {
            const locator = claim.selection.locator;
            return (
              <article
                key={claim.key}
                className="space-y-1 rounded border border-border p-3 text-xs"
                data-arrival-claim={claim.key}
                data-verification={claim.verification}
              >
                <p>{claimSubject(arrival, claim.subject)}</p>
                <p>{claimValue(claim.claim)}</p>
                <blockquote className="whitespace-pre-wrap break-words">
                  {claim.selection.verbatim}
                </blockquote>
                <p className="break-all">
                  Document: {claim.selection.documentKey} · {claim.selection.expectedSha256}
                </p>
                <p>
                  {locator.kind === 'pdf-region'
                    ? `Page ${locator.page1Based} · ${locator.description}`
                    : locator.kind === 'json-pointer'
                      ? `JSON location: ${locator.pointer || '(root)'}`
                      : `Original text bytes ${locator.startByte} to ${locator.endByte}`}
                </p>
                <p>
                  {claim.verification === 'operator-cited-pdf-region'
                    ? 'Operator-cited PDF region; extraction was not verified'
                    : 'Exact original text selection verified'}
                </p>
              </article>
            );
          })}
        </section>
      ) : null}
      {arrival.documents.map((source) => (
        <div key={source.key} className="space-y-1 text-xs">
          <p className="break-all">
            Document {source.key} · {source.coverage.kind} · {source.sha256} · {source.byteLength}{' '}
            bytes
          </p>
          {source.coverage.kind === 'excerpt' ? (
            <p>Excerpt scope: {source.coverage.reason}</p>
          ) : null}
          <Button
            disabled={pending || !data.state.arrivals[arrival.id]}
            onClick={() => void readDocument(source.key)}
          >
            Read retained document {source.key}
          </Button>
        </div>
      ))}
      {failed ? <Notice tone="error">{failed}</Notice> : null}
      {document?.kind === 'unavailable' ? (
        <Notice>{document.message}</Notice>
      ) : document?.kind === 'available' && document.arrivalId === arrival.id ? (
        <div className="space-y-2">
          <p className="text-xs">
            Original retained {document.document.coverage.kind} · {document.document.mediaType}
          </p>
          {document.body.encoding === 'utf8' ? (
            <TextArea
              readOnly
              aria-label="Retained original delivery document"
              value={document.body.value}
              rows={8}
            />
          ) : (
            <Notice>
              The original binary document is retained exactly. Download it to inspect the original
              bytes.
            </Notice>
          )}
          {download ? (
            <a
              className="inline-block text-sm underline"
              href={download.url}
              download={download.name}
            >
              Download retained original {document.document.key}
            </a>
          ) : null}
        </div>
      ) : null}
    </section>
  );
}
