import type { TextFileAtomicWriteInput } from '../../shared/text-file-atomic';

type FileDocumentSaveResult = {
  content: string;
  revision: number;
  saved: true;
  dirty: boolean;
};
const pendingSaves = new Map<
  string,
  { baseline: string; promise: Promise<FileDocumentSaveResult> }
>();

export async function waitForFileDocumentSaves(path: string) {
  for (;;) {
    const pending = pendingSaves.get(path);
    if (!pending) return;
    await pending.promise.catch(() => {});
  }
}

async function textHash(text: string) {
  const bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return `sha256:${Array.from(new Uint8Array(bytes), (byte) => byte.toString(16).padStart(2, '0')).join('')}`;
}

export async function saveCurrentFileEdits(
  document: Pick<FileDocumentDraft, 'revision' | 'dirty'>,
  write: () => Promise<boolean>,
  stillOpen: () => boolean
) {
  const publishedRevision = document.revision;
  let writtenRevision: number;
  do {
    writtenRevision = document.revision;
    if (!(await write()) || !stillOpen()) return false;
  } while (document.dirty);
  if (writtenRevision !== document.revision) return false;
  return writtenRevision === publishedRevision
    ? true
    : { publishedRevision, settledRevision: writtenRevision };
}

export class FileDocumentDraft {
  readonly sessionId = crypto.randomUUID();
  content: string | null = null;
  persistedContent: string | null = null;
  diskContent: string | null = null;
  revision = 0;
  persistedRevision = 0;
  private readonly saves = new Map<number, Promise<FileDocumentSaveResult>>();

  constructor(readonly filePath: string) {}

  get revisionId() {
    return `file-draft-v1:${this.sessionId}:${this.revision}`;
  }
  get dirty() {
    return this.content !== this.persistedContent;
  }
  get saving() {
    return this.saves.size > 0;
  }

  load(content: string, diskContent = content) {
    this.content = content;
    this.persistedContent = content;
    this.diskContent = diskContent;
    this.revision += 1;
    this.persistedRevision = this.revision;
  }

  change(content: string | null) {
    if (this.content === content) return;
    this.content = content;
    this.revision += 1;
  }

  async save(
    write: (input: TextFileAtomicWriteInput) => Promise<void>,
    assertCurrent: () => void = () => {},
    afterPublish?: () => Promise<void>
  ) {
    const content = this.content;
    const revision = this.revision;
    if (content === null || this.diskContent === null)
      throw new Error('The file is not ready to save.');
    const sameRevision = this.saves.get(revision);
    if (sameRevision) return sameRevision;
    const baseline = this.diskContent;
    const previous = pendingSaves.get(this.filePath);
    const run = (async (): Promise<FileDocumentSaveResult> => {
      const published = previous ? await previous.promise : null;
      assertCurrent();
      const diskContent =
        published && previous?.baseline === baseline ? published.content : this.diskContent!;
      const expectedContentHash = await textHash(diskContent);
      await write({ path: this.filePath, content, expectedContentHash });
      this.persistedContent = content;
      this.diskContent = content;
      this.persistedRevision = revision;
      if (afterPublish) await afterPublish();
      return { content, revision, saved: true, dirty: this.dirty };
    })();
    this.saves.set(revision, run);
    pendingSaves.set(this.filePath, { baseline, promise: run });
    try {
      return await run;
    } finally {
      if (this.saves.get(revision) === run) this.saves.delete(revision);
      if (pendingSaves.get(this.filePath)?.promise === run) pendingSaves.delete(this.filePath);
    }
  }
}
