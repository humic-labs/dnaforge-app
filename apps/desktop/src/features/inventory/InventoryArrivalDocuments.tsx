import type {
  InventoryArrivalDraft,
  InventoryArrivalSession,
  InventoryArrivalDocumentDraft,
} from './inventory-arrival-session';
import { newArrivalDocument } from './inventory-arrival-session';
import { Button, Notice, Select, TextArea } from '../../components/ui';
import { PhysicalField } from './InventoryPhysicalControls';

export function InventoryArrivalDocuments({
  draft,
  session,
  reading,
}: {
  draft: InventoryArrivalDraft;
  session: InventoryArrivalSession;
  reading: boolean;
}) {
  const editDocument = (key: string, change: Partial<InventoryArrivalDocumentDraft>) =>
    session.edit({
      ...draft,
      documents: draft.documents.map((document) =>
        document.key === key ? { ...document, ...change } : document
      ),
    });
  return (
    <section className="space-y-4" aria-label="Original supplier documents">
      <h3 className="font-semibold">Original supplier documents</h3>
      {draft.documents.map((document, index) => {
        const label = (value: string) =>
          index === 0 ? value : `Document ${index + 1} ${value.toLowerCase()}`;
        return (
          <section
            key={document.key}
            className="space-y-3 rounded border border-border p-3"
            data-testid="inventory-arrival-document"
            data-document-key={document.key}
            data-file-state={document.fileName && document.body.value ? 'retained' : 'empty'}
          >
            <h4 className="text-sm font-semibold">Document {index + 1}</h4>
            <fieldset className="space-y-3" disabled={reading}>
              <PhysicalField label={label('Document format')}>
                <Select
                  ariaLabel={label('Document format')}
                  value={document.mediaType}
                  options={[
                    { value: 'text/plain', label: 'Plain text' },
                    { value: 'text/csv', label: 'CSV text' },
                    { value: 'application/json', label: 'JSON text' },
                    { value: 'application/pdf', label: 'PDF original' },
                  ]}
                  onValueChange={(value) =>
                    editDocument(document.key, {
                      mediaType: value as InventoryArrivalDocumentDraft['mediaType'],
                      body: {
                        encoding: value === 'application/pdf' ? 'base64' : 'utf8',
                        value: '',
                      },
                      fileName: null,
                      coverage: '',
                      excerptReason: '',
                    })
                  }
                />
              </PhysicalField>
              <PhysicalField label={label('Original supplier document file')}>
                <input
                  type="file"
                  className="block w-full text-sm"
                  aria-label={label('Original supplier document file')}
                  accept={document.mediaType}
                  onChange={(event) => {
                    const file = event.currentTarget.files?.[0];
                    if (file) void session.readDocumentFile(document.key, file, document.mediaType);
                    event.currentTarget.value = '';
                  }}
                />
              </PhysicalField>
              {document.fileName ? (
                <p className="break-words text-xs" data-retained-file-name>
                  {document.fileName} · Original file bytes retained
                </p>
              ) : null}
              {document.mediaType !== 'application/pdf' && document.body.encoding === 'utf8' ? (
                <PhysicalField label={label('Original supplier document text')}>
                  <TextArea
                    aria-label={label('Original supplier document text')}
                    value={document.body.value}
                    onChange={(event) =>
                      editDocument(document.key, {
                        body: { encoding: 'utf8', value: event.target.value },
                        fileName: null,
                      })
                    }
                    rows={6}
                  />
                </PhysicalField>
              ) : document.body.value ? (
                <p className="text-xs">
                  Original binary content is retained. Supplier quotations are cited separately
                  below.
                </p>
              ) : null}
              <PhysicalField label={label('Document coverage')}>
                <Select
                  ariaLabel={label('Document coverage')}
                  value={document.coverage}
                  options={[
                    { value: '', label: 'Choose full document or excerpt' },
                    {
                      value: 'full',
                      label:
                        document.mediaType === 'application/pdf'
                          ? 'Full original document'
                          : 'Full original text document',
                    },
                    {
                      value: 'excerpt',
                      label:
                        document.mediaType === 'application/pdf'
                          ? 'Explicitly labeled document excerpt'
                          : 'Explicitly labeled text excerpt',
                    },
                  ]}
                  onValueChange={(value) =>
                    editDocument(document.key, {
                      coverage: value as InventoryArrivalDocumentDraft['coverage'],
                    })
                  }
                />
              </PhysicalField>
              {document.coverage === 'excerpt' ? (
                <PhysicalField label={label('Excerpt scope reason')}>
                  <TextArea
                    aria-label={label('Excerpt scope reason')}
                    value={document.excerptReason}
                    onChange={(event) =>
                      editDocument(document.key, { excerptReason: event.target.value })
                    }
                  />
                </PhysicalField>
              ) : null}
              {draft.documents.length > 1 ? (
                <Button
                  onClick={() =>
                    session.edit({
                      ...draft,
                      documents: draft.documents.filter((item) => item.key !== document.key),
                    })
                  }
                >
                  Remove document {index + 1}
                </Button>
              ) : null}
            </fieldset>
          </section>
        );
      })}
      {reading ? (
        <div className="space-y-2">
          <p role="status">Reading complete original document…</p>
          <Button onClick={() => session.cancelDocumentRead()}>Cancel document read</Button>
        </div>
      ) : null}
      <Button
        disabled={reading}
        onClick={() =>
          session.edit({
            ...draft,
            documents: [...draft.documents, newArrivalDocument(crypto.randomUUID())],
          })
        }
      >
        Add another document
      </Button>
      <Notice>
        Retain original bytes and choose full document or excerpt explicitly. Changing a document
        removes its old supplier statement links. Files must fit local recovery storage before
        receiving.
      </Notice>
    </section>
  );
}
