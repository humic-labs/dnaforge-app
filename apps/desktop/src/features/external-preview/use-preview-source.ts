import { useEffect, useState } from 'react';
import { platform } from '../../platform';
import { sha256Hex } from '../../shared/sha256';

export interface PreviewProps {
  path: string;
  onSnapshot?: (sha256: string | null) => void;
}

type Source<T> =
  | { path: string; status: 'loaded'; document: T; sha256: string }
  | { path: string; status: 'error'; message: string };

export function usePreviewSource<T>(
  path: string,
  maxBytes: number,
  decode: (bytes: Uint8Array, path: string) => T
) {
  const [source, setSource] = useState<Source<T> | null>(null);
  useEffect(() => {
    let active = true;
    async function load() {
      const bytes = await platform().fileAssociations.readPreviewBytes(path, maxBytes);
      if (!active) return;
      const sha256 = await sha256Hex(bytes);
      if (!active) return;
      const document = decode(bytes, path);
      setSource({ path, status: 'loaded', document, sha256 });
    }
    setSource(null);
    void load().catch((error: unknown) => {
      if (active)
        setSource({ path, status: 'error', message: previewErrorMessage(error, maxBytes) });
    });
    return () => {
      active = false;
    };
  }, [path, maxBytes, decode]);
  return source?.path === path ? source : null;
}

function previewErrorMessage(error: unknown, maxBytes: number): string {
  const message = error instanceof Error ? error.message : 'Could not read this file.';
  if (/exceeds bounded read limit/i.test(message))
    return `This file exceeds the ${maxBytes / 1024 / 1024} MiB preview limit.`;
  if (/ENOENT|no such file/i.test(message)) return 'This file is no longer available.';
  if (/EACCES|EPERM|permission denied/i.test(message))
    return 'DNAForge does not have permission to read this file.';
  return message;
}

export function useDisplayedSnapshot(
  onSnapshot: PreviewProps['onSnapshot'],
  sha256: string | null
) {
  useEffect(() => {
    onSnapshot?.(sha256);
    return () => onSnapshot?.(null);
  }, [onSnapshot, sha256]);
}
