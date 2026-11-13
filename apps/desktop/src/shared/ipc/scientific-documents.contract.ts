import { defineGroup, invoke } from './contract';

export const scientificDocumentsContract = defineGroup('scientificDocuments', {
  read: invoke<
    [request: import('../scientific-document-ipc').DesktopScientificDocumentReadRequest],
    import('../../../../../packages/core/domain-services/src/scientific-documents').ScientificDocumentReadResult
  >(),
  cancelRead: invoke<
    [request: import('../scientific-document-ipc').DesktopScientificDocumentCancelRequest],
    void
  >(),
});
