import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, stat, unlink, writeFile } from 'node:fs/promises';
import { basename, extname, join } from 'node:path';
import { userMessagePayload, userMessageValue, withUserMessage } from '@waypoint/user-messages';

import {
  AGENT_ATTACHMENT_MAX_BYTES,
  isAgentAttachmentManifest,
  type AgentAttachmentManifest,
} from '../../shared/agent-attachments';

const MEDIA_TYPES = new Map<string, string>([
  ['.csv', 'text/csv'],
  ['.fa', 'text/x-fasta'],
  ['.fas', 'text/x-fasta'],
  ['.fasta', 'text/x-fasta'],
  ['.gb', 'text/x-genbank'],
  ['.gbk', 'text/x-genbank'],
  ['.json', 'application/json'],
  ['.md', 'text/markdown'],
  ['.seq', 'text/plain'],
  ['.txt', 'text/plain'],
]);

export interface AgentAttachmentStoreOptions {
  rootDir: string;
  maxBytes?: number;
}

export class AgentAttachmentStore {
  private readonly rootDir: string;
  private readonly maxBytes: number;

  constructor(options: AgentAttachmentStoreOptions) {
    this.rootDir = options.rootDir;
    this.maxBytes = options.maxBytes ?? AGENT_ATTACHMENT_MAX_BYTES;
  }

  async capture(sourcePath: string): Promise<AgentAttachmentManifest> {
    const extension = extname(sourcePath).toLowerCase();
    const mediaType = MEDIA_TYPES.get(extension);
    if (!mediaType) throw new Error(`Unsupported AI attachment type: ${extension || 'none'}.`);
    const metadata = await stat(sourcePath);
    if (!metadata.isFile()) throw new Error('AI attachments must be regular files.');
    if (metadata.size > this.maxBytes) {
      throw withUserMessage(
        new Error(
          `AI attachments must be ${this.maxBytes.toLocaleString('en-US')} bytes or smaller; this file is ${metadata.size.toLocaleString('en-US')} bytes.`
        ),
        userMessagePayload('assistant.attachmentSizeLimit', {
          limit: userMessageValue(this.maxBytes.toLocaleString('en-US')),
          size: userMessageValue(metadata.size.toLocaleString('en-US')),
        })
      );
    }
    const bytes = await readFile(sourcePath);
    if (bytes.byteLength !== metadata.size || bytes.byteLength > this.maxBytes) {
      throw new Error('The AI attachment changed while it was being captured. Attach it again.');
    }
    try {
      new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    } catch {
      throw new Error('AI attachments must contain valid UTF-8 text.');
    }
    const sha256 = createHash('sha256').update(bytes).digest('hex');
    const name = basename(sourcePath);
    if (
      !name ||
      name.length > 255 ||
      !isAgentAttachmentManifest({
        id: `attachment-${sha256}`,
        sha256,
        name,
        kind: 'text',
        mediaType,
        size: bytes.byteLength,
      })
    ) {
      throw new Error('The AI attachment filename is invalid.');
    }
    await mkdir(this.rootDir, { recursive: true, mode: 0o700 });
    const destination = join(this.rootDir, sha256);
    const temporary = join(this.rootDir, `.${sha256}.${randomUUID()}.tmp`);
    try {
      await writeFile(temporary, bytes, { mode: 0o600, flag: 'wx' });
      await rename(temporary, destination).catch(async (error: unknown) => {
        const existing = await readFile(destination).catch(() => null);
        if (!existing || !existing.equals(bytes)) throw error;
      });
    } finally {
      await unlink(temporary).catch(() => undefined);
    }
    return {
      id: `attachment-${sha256}`,
      sha256,
      name,
      kind: 'text',
      mediaType,
      size: bytes.byteLength,
    };
  }

  async readText(manifest: AgentAttachmentManifest): Promise<string> {
    if (!isAgentAttachmentManifest(manifest) || manifest.size > this.maxBytes) {
      throw new Error('The AI attachment manifest is invalid.');
    }
    const bytes = await readFile(join(this.rootDir, manifest.sha256));
    const actualHash = createHash('sha256').update(bytes).digest('hex');
    if (bytes.byteLength !== manifest.size || actualHash !== manifest.sha256) {
      throw new Error('The AI attachment manifest does not match its immutable snapshot.');
    }
    try {
      return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    } catch {
      throw new Error('The stored AI attachment is not valid UTF-8 text.');
    }
  }

  async projectText(manifests: readonly AgentAttachmentManifest[]): Promise<string> {
    const sections = await Promise.all(
      manifests.map(async (manifest) => {
        const content = await this.readText(manifest);
        return `--- Attached file: ${manifest.name} (${manifest.mediaType}, sha256:${manifest.sha256}) ---\n${content}\n--- End attached file: ${manifest.name} ---`;
      })
    );
    return sections.join('\n\n');
  }
}
