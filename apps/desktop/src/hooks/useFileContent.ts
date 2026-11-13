import { useState, useEffect, useCallback, useRef } from 'react';
import { getFileSystem } from './useMockedFileSystem';
import { resolveFilePathWithFallback } from './resolveFilePath';
import type { SequenceFormat } from '@waypoint/sequence-utils';
import type { AnnotatedSequence } from '@waypoint/sequence-utils';
import { isBinarySequenceFilePath } from '@waypoint/sequence-utils/sequence-file-types';
import {
  parseBinarySequenceFileAsAnnotated,
  parseTextSequenceFileAsAnnotated,
} from '../shared/parse-sequence-file';
import { findWorkspaceRootForPath } from '../db/workspace-catalog';
import { useWorkspaceStore } from '../stores/workspaceStore';
import { readStableWorkspaceGeneration } from '../services/workspace-sync-renderer-generation';
import { readSequenceText } from '../features/sequence/read-sequence-text';
import type { ScientificAcceptedDocumentRevision } from '@waypoint/domain-services';

export interface UseFileContentReturn {
  sequence: AnnotatedSequence | null;
  acceptedRevision: ScientificAcceptedDocumentRevision | null;

  rawContent: string | null;

  loading: boolean;

  error: string | null;

  errorClass: SequenceFileLoadErrorClass | null;

  format: SequenceFormat | 'unknown' | null;

  reload: () => Promise<void>;
}

export type SequenceFileLoadErrorClass = 'parse_failed' | 'filesystem';

type FileContentData = Pick<
  UseFileContentReturn,
  'sequence' | 'acceptedRevision' | 'rawContent' | 'format'
>;

type FileContentState =
  | { phase: 'idle'; path: null }
  | { phase: 'loading'; path: string; data: FileContentData }
  | { phase: 'ready'; path: string; data: FileContentData }
  | {
      phase: 'error';
      path: string;
      data: FileContentData;
      error: string;
      errorClass: SequenceFileLoadErrorClass;
    };

const emptyContent: FileContentData = {
  sequence: null,
  acceptedRevision: null,
  rawContent: null,
  format: null,
};

export function useFileContent(filePath: string | null): UseFileContentReturn {
  const [state, setState] = useState<FileContentState>({ phase: 'idle', path: null });
  const scope = useRef<{ path: string | null } | null>(null);
  const currentRequest = useRef<object | null>(null);

  const loadFile = useCallback(async () => {
    const owner = scope.current;
    if (!owner || owner.path !== filePath) return;
    const request = {};
    currentRequest.current = request;
    const isCurrent = () => scope.current === owner && currentRequest.current === request;
    if (!filePath) {
      setState({ phase: 'idle', path: null });
      return;
    }
    setState((previous) => ({
      phase: 'loading',
      path: filePath,
      data: previous.phase !== 'idle' && previous.path === filePath ? previous.data : emptyContent,
    }));
    let failureClass: SequenceFileLoadErrorClass = 'filesystem';
    try {
      const resolvedPath = resolveFilePathWithFallback(filePath);
      const workspaceRoot = findWorkspaceRootForPath(
        useWorkspaceStore.getState().folders,
        resolvedPath
      );
      const fs = await getFileSystem();
      if (!isCurrent()) return;
      if (isBinarySequenceFilePath(filePath)) {
        const bytes = await readStableWorkspaceGeneration(workspaceRoot, () =>
          fs.readFile(resolvedPath)
        );
        if (!isCurrent()) return;
        failureClass = 'parse_failed';
        const parsed = parseBinarySequenceFileAsAnnotated(bytes, filePath);
        setState({
          phase: 'ready',
          path: filePath,
          data: {
            rawContent: `[Binary file: ${bytes.byteLength} bytes]`,
            sequence: parsed.sequence,
            format: parsed.format,
            acceptedRevision: null,
          },
        });
      } else {
        const loaded = await readStableWorkspaceGeneration(workspaceRoot, () =>
          readSequenceText(resolvedPath, workspaceRoot, (path) => fs.readTextFile(path))
        );
        if (!isCurrent()) return;
        try {
          const parsed = parseTextSequenceFileAsAnnotated(loaded.content, filePath);
          setState({
            phase: 'ready',
            path: filePath,
            data: {
              rawContent: loaded.content,
              acceptedRevision: loaded.acceptedRevision,
              sequence: parsed.sequence,
              format: parsed.format,
            },
          });
        } catch (error) {
          setState({
            phase: 'error',
            path: filePath,
            errorClass: 'parse_failed',
            error:
              error instanceof Error && error.message
                ? `This file could not be read as a sequence. ${error.message}`
                : 'This file could not be read as a sequence.',
            data: {
              rawContent: loaded.content,
              acceptedRevision: loaded.acceptedRevision,
              sequence: null,
              format: 'unknown',
            },
          });
        }
      }
    } catch (error) {
      if (!isCurrent()) return;
      console.error('Failed to read/parse file:', error);
      setState({
        phase: 'error',
        path: filePath,
        data: emptyContent,
        error: error instanceof Error ? error.message : 'Failed to read file',
        errorClass: failureClass,
      });
    }
  }, [filePath]);

  useEffect(() => {
    const owner = { path: filePath };
    scope.current = owner;
    void loadFile();
    return () => {
      if (scope.current === owner) {
        scope.current = null;
        currentRequest.current = null;
      }
    };
  }, [filePath, loadFile]);

  const visible = state.path === filePath ? state : null;
  return {
    ...(visible && visible.phase !== 'idle' ? visible.data : emptyContent),
    loading: filePath !== null && (!visible || visible.phase === 'loading'),
    error: visible?.phase === 'error' ? visible.error : null,
    errorClass: visible?.phase === 'error' ? visible.errorClass : null,
    reload: loadFile,
  };
}
