import { platform } from '../../platform';
import { NATIVE_DOCUMENT_MAX_BODY_BYTES } from '../../shared/native-document-transport';

export async function readInventoryArchiveFile(path: string): Promise<string> {
  const bytes = await platform().fs.readFileBounded(path, NATIVE_DOCUMENT_MAX_BODY_BYTES);
  return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
}
