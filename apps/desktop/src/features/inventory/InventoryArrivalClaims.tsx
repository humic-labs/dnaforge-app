import { useEffect, useState } from 'react';
import type { InventoryArrivalSupplierClaimInput } from '@waypoint/domain-services';
import { Button, Notice, Select, TextArea, TextField } from '../../components/ui';
import { PhysicalField } from './InventoryPhysicalControls';
import {
  inventoryArrivalDocumentText,
  inventoryArrivalTextSelection,
  inventoryArrivalDocumentSelection,
  type InventoryArrivalDraft,
  type InventoryArrivalSession,
} from './inventory-arrival-session';

type Editor = {
  key: string;
  documentKey: string;
  subject: string;
  kind: '' | InventoryArrivalSupplierClaimInput['claim']['kind'];
  locator: 'utf8-byte-range' | 'json-pointer' | 'pdf-region';
  start: number;
  end: number;
  quotation: string;
  pointer: string;
  page: string;
  region: string;
  value: string;
  unit: string;
  role: 'product' | 'packaging-batch' | 'component-batch';
};

function subjectLabel(
  draft: InventoryArrivalDraft,
  subject: InventoryArrivalSupplierClaimInput['subject']
) {
  if (subject.kind === 'delivery') return 'This delivery';
  if (subject.kind === 'package') return `Package: ${draft.packageLabel}`;
  return `Component: ${draft.components.find((component) => component.key === subject.componentKey)?.label ?? subject.componentKey}`;
}

export function InventoryArrivalClaims({
  draft,
  session,
  onEditingChange,
  disabled,
}: {
  draft: InventoryArrivalDraft;
  session: InventoryArrivalSession;
  onEditingChange(value: boolean): void;
  disabled: boolean;
}) {
  const [editor, setEditor] = useState<Editor | null>(null);
  const [error, setError] = useState<string | null>(null);
  const delivery = JSON.stringify([draft.namespace, draft.deliveryId]);
  useEffect(() => {
    setEditor(null);
    setError(null);
    onEditingChange(false);
  }, [delivery, onEditingChange]);
  const update = (change: Partial<Editor>) =>
    setEditor((current) => (current ? { ...current, ...change } : null));
  const document = draft.documents.find((item) => item.key === editor?.documentKey);
  const text = document ? inventoryArrivalDocumentText(document) : null;
  function finish() {
    if (!editor || !document) return;
    setError(null);
    try {
      if (!editor.subject || !editor.kind) throw Error('Choose the statement subject and kind.');
      const subject = JSON.parse(editor.subject) as InventoryArrivalSupplierClaimInput['subject'];
      const selection =
        editor.locator === 'utf8-byte-range'
          ? inventoryArrivalTextSelection(document, editor.start, editor.end)
          : inventoryArrivalDocumentSelection(
              document,
              editor.locator === 'pdf-region'
                ? {
                    kind: 'pdf-region',
                    page1Based: Number(editor.page),
                    description: editor.region,
                  }
                : { kind: 'json-pointer', pointer: editor.pointer },
              editor.quotation
            );
      const claim: InventoryArrivalSupplierClaimInput['claim'] =
        editor.kind === 'quantity'
          ? { kind: 'quantity', valueLexeme: editor.value, unitText: editor.unit }
          : editor.kind === 'supplier-qc'
            ? { kind: 'supplier-qc', resultText: editor.value }
            : editor.kind === 'identifier'
              ? { kind: 'identifier', role: editor.role, value: editor.value }
              : { kind: 'date-or-condition', text: editor.value };
      session.edit({
        ...draft,
        claims: [...draft.claims, { key: editor.key, subject, selection, claim }],
      });
      setEditor(null);
      onEditingChange(false);
    } catch (cause) {
      setError(
        cause instanceof Error ? cause.message : 'The supplier statement could not be added.'
      );
    }
  }
  return (
    <section className="space-y-3" aria-label="Supplier statements">
      <h3 className="font-semibold">Supplier statements</h3>
      <p className="text-xs">
        Record what the supplier says, with its original document location. These statements do not
        release lots or set local expiry.
      </p>
      {draft.claims.map((claim) => (
        <article
          key={claim.key}
          className="space-y-1 rounded border border-border p-3 text-xs"
          data-testid="inventory-arrival-claim"
          data-claim-key={claim.key}
        >
          <p>
            {claim.claim.kind === 'quantity'
              ? `Quantity: ${claim.claim.valueLexeme} ${claim.claim.unitText}`
              : claim.claim.kind === 'supplier-qc'
                ? `Supplier quality result: ${claim.claim.resultText}`
                : claim.claim.kind === 'identifier'
                  ? `${claim.claim.role}: ${claim.claim.value}`
                  : `Supplier date or condition: ${claim.claim.text}`}
          </p>
          <p>{subjectLabel(draft, claim.subject)}</p>
          <blockquote className="whitespace-pre-wrap break-words">
            {claim.selection.verbatim}
          </blockquote>
          <p>
            {claim.selection.locator.kind === 'pdf-region'
              ? 'Operator-cited PDF region; extraction is not verified'
              : 'Original text selection checked during preview'}
          </p>
          <Button
            disabled={disabled}
            onClick={() =>
              session.edit({
                ...draft,
                claims: draft.claims.filter((item) => item.key !== claim.key),
              })
            }
          >
            Remove statement
          </Button>
        </article>
      ))}
      {editor ? (
        <fieldset
          className="space-y-3 rounded border border-border p-3"
          disabled={disabled}
          data-testid="inventory-arrival-claim-editor"
        >
          <PhysicalField label="Statement subject">
            <Select
              ariaLabel="Statement subject"
              value={editor.subject}
              options={[
                { value: '', label: 'Choose who this statement describes' },
                { value: JSON.stringify({ kind: 'delivery' }), label: 'This delivery' },
                ...(draft.packageLabel.trim()
                  ? [
                      {
                        value: JSON.stringify({ kind: 'package', packageKey: 'package-1' }),
                        label: `Package: ${draft.packageLabel}`,
                      },
                    ]
                  : []),
                ...draft.components.map((component, index) => ({
                  value: JSON.stringify({ kind: 'component', componentKey: component.key }),
                  label: `Component ${index + 1}: ${component.label || 'Unnamed component'}`,
                })),
              ]}
              onValueChange={(value) => update({ subject: value })}
            />
          </PhysicalField>
          <PhysicalField label="Statement document">
            <Select
              ariaLabel="Statement document"
              value={editor.documentKey}
              options={[
                { value: '', label: 'Choose the retained original document' },
                ...draft.documents.map((item, index) => ({
                  value: item.key,
                  label: `Document ${index + 1}${item.fileName ? `: ${item.fileName}` : ''}`,
                })),
              ]}
              onValueChange={(value) => {
                const next = draft.documents.find((item) => item.key === value);
                update({
                  documentKey: value,
                  locator: next?.mediaType === 'application/pdf' ? 'pdf-region' : 'utf8-byte-range',
                  start: 0,
                  end: 0,
                  quotation: '',
                });
              }}
            />
          </PhysicalField>
          <PhysicalField label="Statement kind">
            <Select
              ariaLabel="Statement kind"
              value={editor.kind}
              options={[
                { value: '', label: 'Choose the supplier statement kind' },
                { value: 'quantity', label: 'Quantity' },
                { value: 'supplier-qc', label: 'Supplier quality result' },
                { value: 'identifier', label: 'Identifier' },
                { value: 'date-or-condition', label: 'Date or condition' },
              ]}
              onValueChange={(value) =>
                update({ kind: value as Editor['kind'], value: '', unit: '' })
              }
            />
          </PhysicalField>
          {document?.mediaType === 'application/pdf' ? (
            <>
              <Notice>
                This is an operator-cited PDF region. The application retains the original PDF and
                does not verify text extraction.
              </Notice>
              <PhysicalField label="PDF page">
                <TextField
                  aria-label="PDF page"
                  inputMode="numeric"
                  value={editor.page}
                  onChange={(event) => update({ page: event.target.value })}
                />
              </PhysicalField>
              <PhysicalField label="PDF region">
                <TextField
                  aria-label="PDF region"
                  value={editor.region}
                  onChange={(event) => update({ region: event.target.value })}
                />
              </PhysicalField>
            </>
          ) : document ? (
            <>
              {document.mediaType === 'application/json' ? (
                <PhysicalField label="Text location">
                  <Select
                    ariaLabel="Text location"
                    value={editor.locator}
                    options={[
                      { value: 'utf8-byte-range', label: 'Select exact original text' },
                      { value: 'json-pointer', label: 'Specify a JSON pointer' },
                    ]}
                    onValueChange={(value) =>
                      update({
                        locator: value as Editor['locator'],
                        start: 0,
                        end: 0,
                        quotation: '',
                      })
                    }
                  />
                </PhysicalField>
              ) : null}
              {editor.locator === 'utf8-byte-range' ? (
                <PhysicalField label="Select exact original text">
                  <TextArea
                    readOnly
                    aria-label="Select exact original text"
                    value={text ?? ''}
                    rows={6}
                    onSelect={(event) => {
                      const target = event.currentTarget;
                      update({
                        start: target.selectionStart,
                        end: target.selectionEnd,
                        quotation: target.value.slice(target.selectionStart, target.selectionEnd),
                      });
                    }}
                  />
                </PhysicalField>
              ) : (
                <PhysicalField label="JSON pointer">
                  <TextField
                    aria-label="JSON pointer"
                    value={editor.pointer}
                    onChange={(event) => update({ pointer: event.target.value })}
                  />
                </PhysicalField>
              )}
            </>
          ) : null}
          <PhysicalField label="Exact supplier quotation">
            <TextArea
              aria-label="Exact supplier quotation"
              readOnly={editor.locator === 'utf8-byte-range'}
              value={editor.quotation}
              onChange={(event) => update({ quotation: event.target.value })}
            />
          </PhysicalField>
          {editor.kind === 'identifier' ? (
            <PhysicalField label="Identifier describes">
              <Select
                ariaLabel="Identifier describes"
                value={editor.role}
                options={[
                  { value: 'product', label: 'Product' },
                  { value: 'packaging-batch', label: 'Packaging batch' },
                  { value: 'component-batch', label: 'Component batch' },
                ]}
                onValueChange={(value) => update({ role: value as Editor['role'] })}
              />
            </PhysicalField>
          ) : null}
          {editor.kind ? (
            <PhysicalField
              label={
                editor.kind === 'quantity'
                  ? 'Supplier quantity'
                  : editor.kind === 'supplier-qc'
                    ? 'Supplier quality result'
                    : editor.kind === 'identifier'
                      ? 'Supplier identifier'
                      : 'Supplier date or condition'
              }
            >
              <TextField
                aria-label={
                  editor.kind === 'quantity'
                    ? 'Supplier quantity'
                    : editor.kind === 'supplier-qc'
                      ? 'Supplier quality result'
                      : editor.kind === 'identifier'
                        ? 'Supplier identifier'
                        : 'Supplier date or condition'
                }
                value={editor.value}
                onChange={(event) => update({ value: event.target.value })}
              />
            </PhysicalField>
          ) : null}
          {editor.kind === 'quantity' ? (
            <PhysicalField label="Supplier unit">
              <TextField
                aria-label="Supplier unit"
                value={editor.unit}
                onChange={(event) => update({ unit: event.target.value })}
              />
            </PhysicalField>
          ) : null}
          {error ? <Notice tone="error">{error}</Notice> : null}
          <div className="flex gap-2">
            <Button onClick={finish}>Add statement</Button>
            <Button
              onClick={() => {
                setEditor(null);
                setError(null);
                onEditingChange(false);
              }}
            >
              Cancel statement
            </Button>
          </div>
        </fieldset>
      ) : (
        <Button
          disabled={disabled}
          onClick={() => {
            session.edit(draft);
            setEditor({
              key: crypto.randomUUID(),
              documentKey: '',
              subject: '',
              kind: '',
              locator: 'utf8-byte-range',
              start: 0,
              end: 0,
              quotation: '',
              pointer: '',
              page: '1',
              region: '',
              value: '',
              unit: '',
              role: 'product',
            });
            onEditingChange(true);
          }}
        >
          Add supplier statement
        </Button>
      )}
    </section>
  );
}
