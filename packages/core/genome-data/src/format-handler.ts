export type FormatInput =
  | { kind: 'path'; path: string }
  | { kind: 'url'; url: string }
  | { kind: 'blob'; blob: Uint8Array; filename?: string };

export interface TrackSource {
  uri: string;
  formatId: string;
  input?: FormatInput;
  recommendedTypes?: ReadonlyArray<string>;
  fingerprint?: string;
  index?: FormatInput;
  reference?: FormatInput;
}

export interface FormatHandler {
  readonly id: string;
  readonly extensions: ReadonlyArray<string>;
  readonly magic?: Uint8Array;
  readonly mimeTypes?: ReadonlyArray<string>;
  readonly recommendedTypes: ReadonlyArray<string>;
  toTrackSource(input: FormatInput): TrackSource;
}

export interface FormatDetectionHints {
  mime?: string;
  magic?: Uint8Array;
}

export class FormatHandlerRegistry {
  private byId = new Map<string, FormatHandler>();
  private byExt = new Map<string, FormatHandler>();
  private byMime = new Map<string, FormatHandler>();

  register(handler: FormatHandler): void {
    if (this.byId.has(handler.id)) {
      throw new Error(`FormatHandler "${handler.id}" is already registered`);
    }
    this.byId.set(handler.id, handler);
    for (const ext of handler.extensions) {
      this.byExt.set(normalizeExtension(ext), handler);
    }
    for (const mime of handler.mimeTypes ?? []) {
      this.byMime.set(mime.toLowerCase(), handler);
    }
  }

  unregister(id: string): boolean {
    const handler = this.byId.get(id);
    if (!handler) return false;
    this.byId.delete(id);
    for (const ext of handler.extensions) this.byExt.delete(normalizeExtension(ext));
    for (const mime of handler.mimeTypes ?? []) this.byMime.delete(mime.toLowerCase());
    return true;
  }

  list(): ReadonlyArray<FormatHandler> {
    return Array.from(this.byId.values());
  }

  findById(id: string): FormatHandler | null {
    return this.byId.get(id) ?? null;
  }

  findByExtension(ext: string): FormatHandler | null {
    return this.byExt.get(normalizeExtension(ext)) ?? null;
  }

  findByMime(mime: string): FormatHandler | null {
    return this.byMime.get(mime.toLowerCase()) ?? null;
  }

  detect(input: FormatInput, hints?: FormatDetectionHints): FormatHandler | null {
    const magic = hints?.magic ?? (input.kind === 'blob' ? input.blob : undefined);
    if (magic && magic.length > 0) {
      for (const handler of this.byId.values()) {
        if (matchesMagic(handler.magic, magic)) return handler;
      }
    }
    if (hints?.mime) {
      const byMime = this.findByMime(hints.mime);
      if (byMime) return byMime;
    }
    const filename = extractFilename(input);
    if (filename) {
      const ext = extractExtension(filename);
      if (ext) {
        const byExt = this.findByExtension(ext);
        if (byExt) return byExt;
      }
    }
    return null;
  }
}

export function normalizeExtension(ext: string): string {
  const lower = ext.toLowerCase();
  return lower.startsWith('.') ? lower : `.${lower}`;
}

export function matchesMagic(handlerMagic: Uint8Array | undefined, source: Uint8Array): boolean {
  if (!handlerMagic || handlerMagic.length === 0) return false;
  if (source.length < handlerMagic.length) return false;
  for (let i = 0; i < handlerMagic.length; i++) {
    if (source[i] !== handlerMagic[i]) return false;
  }
  return true;
}

export function extractFilename(input: FormatInput): string | null {
  switch (input.kind) {
    case 'path':
      return basename(input.path);
    case 'url': {
      try {
        const url = new URL(input.url);
        const parts = url.pathname.split('/').filter(Boolean);
        return parts.length > 0 ? parts[parts.length - 1] : null;
      } catch {
        return null;
      }
    }
    case 'blob':
      return input.filename ?? null;
  }
}

export function formatInputUri(input: FormatInput): string {
  switch (input.kind) {
    case 'path':
      return input.path.startsWith('file://') ? input.path : `file://${input.path}`;
    case 'url':
      return input.url;
    case 'blob':
      return `memory:${input.filename ?? 'unnamed'}`;
  }
}

export function extractExtension(filename: string): string | null {
  const lower = filename.toLowerCase();
  const COMPRESSION = new Set(['.gz', '.bgz', '.zst', '.bz2', '.xz']);
  const lastDot = lower.lastIndexOf('.');
  if (lastDot < 0) return null;
  const lastExt = lower.substring(lastDot);
  if (COMPRESSION.has(lastExt)) {
    const prevDot = lower.lastIndexOf('.', lastDot - 1);
    if (prevDot >= 0) return lower.substring(prevDot);
  }
  return lastExt;
}

function basename(path: string): string {
  const sep = Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\'));
  return sep >= 0 ? path.substring(sep + 1) : path;
}
