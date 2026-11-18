export type FileDocumentFlushPurpose = 'synchronize' | 'discard' | 'retire';

export interface FileDocumentClientFlush {
  requestId: string;
  loadId: string;
  purpose?: FileDocumentFlushPurpose;
}
export interface FileDocumentClientFlushAck extends FileDocumentClientFlush {
  success: boolean;
  error?: string;
}
