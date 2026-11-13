import { useState, useCallback, useRef, useEffect } from 'react';
import { gitReadHeadForDiff } from '../../workspace/public/git';
import { computeSequenceDiff, computeAnnotationDiff } from '../diff/sequence-diff';
import { parseGitHeadInWorker } from '../diff/git-head-parser';
import type { DiffResult, AnnotationDiffResult } from '../diff/sequence-diff';
import type { Annotation } from '@waypoint/sequence-utils';
import {
  consumeSequenceTabCloseGesture,
  registerSequenceTabCloseAbortController,
} from '../../../shared/tab-close-gesture';

const DEBOUNCE_MS = 300;

export type GitDiffStatus = 'idle' | 'loading' | 'done' | 'unavailable';

interface UseGitDiffResult {
  diffResult: DiffResult | null;
  annotationDiff: AnnotationDiffResult | null;
  status: GitDiffStatus;

  headSequence: string | null;

  refreshHeadContent: () => void;

  recomputeNow: () => void;
}

export function useGitDiff(
  tabId: string,
  filePath: string | null,
  currentSequence: string | null,
  currentAnnotations: Annotation[] | null
): UseGitDiffResult {
  const [diffResult, setDiffResult] = useState<DiffResult | null>(null);
  const [annotationDiff, setAnnotationDiff] = useState<AnnotationDiffResult | null>(null);
  const [status, setStatus] = useState<GitDiffStatus>('idle');

  const headContentRef = useRef<string | null>(null);
  const headSequenceRef = useRef<string | null>(null);
  const headAnnotationsRef = useRef<Annotation[] | null>(null);

  const requestIdRef = useRef(0);
  const headFetchIdRef = useRef(0);
  const headFetchAbortRef = useRef<AbortController | null>(null);
  const headFetchCloseBindingRef = useRef<(() => void) | null>(null);

  const debounceTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const fetchHeadContent = useCallback(async () => {
    const fetchId = ++headFetchIdRef.current;
    requestIdRef.current += 1;
    headFetchAbortRef.current?.abort();
    headFetchCloseBindingRef.current?.();
    headFetchCloseBindingRef.current = null;
    if (debounceTimerRef.current) {
      clearTimeout(debounceTimerRef.current);
      debounceTimerRef.current = null;
    }
    headContentRef.current = null;
    headSequenceRef.current = null;
    headAnnotationsRef.current = null;
    setDiffResult(null);
    setAnnotationDiff(null);
    if (!filePath) {
      headFetchAbortRef.current = null;
      setStatus('unavailable');
      return;
    }
    setStatus('loading');
    const controller = new AbortController();
    headFetchAbortRef.current = controller;
    const releaseCloseBinding = registerSequenceTabCloseAbortController(tabId, controller);
    headFetchCloseBindingRef.current = releaseCloseBinding;

    try {
      const content = await gitReadHeadForDiff(filePath, controller.signal);
      if (headFetchIdRef.current !== fetchId || controller.signal.aborted) return;
      if (!content) {
        headContentRef.current = null;
        headSequenceRef.current = null;
        headAnnotationsRef.current = null;
        setStatus('unavailable');
        return;
      }

      const parsed = await parseGitHeadInWorker(content, controller.signal);
      if (headFetchIdRef.current !== fetchId || controller.signal.aborted) return;
      headContentRef.current = content;
      headSequenceRef.current = parsed.sequence;
      headAnnotationsRef.current = parsed.annotations;

      setStatus('done');
    } catch {
      if (headFetchIdRef.current !== fetchId || controller.signal.aborted) return;
      headContentRef.current = null;
      headSequenceRef.current = null;
      headAnnotationsRef.current = null;
      setStatus('unavailable');
    } finally {
      if (headFetchAbortRef.current === controller) {
        releaseCloseBinding();
        headFetchCloseBindingRef.current = null;
        headFetchAbortRef.current = null;
      }
    }
  }, [filePath, tabId]);

  const computeDiff = useCallback(async () => {
    const thisRequestId = ++requestIdRef.current;

    if (!currentSequence || !headSequenceRef.current) {
      setDiffResult(null);
      setAnnotationDiff(null);
      return;
    }

    try {
      const seqDiff = await computeSequenceDiff(headSequenceRef.current, currentSequence);
      if (requestIdRef.current !== thisRequestId) return;

      setDiffResult(seqDiff);

      if (headAnnotationsRef.current && currentAnnotations) {
        const annDiff = computeAnnotationDiff(
          headAnnotationsRef.current,
          currentAnnotations,
          seqDiff.changes
        );
        setAnnotationDiff(annDiff);
      }
    } catch (err) {
      console.error('[useGitDiff] Diff computation failed:', err);
      if (requestIdRef.current === thisRequestId) {
        setDiffResult(null);
        setAnnotationDiff(null);
      }
    }
  }, [currentSequence, currentAnnotations]);

  useEffect(() => {
    if (status !== 'done') return;

    if (debounceTimerRef.current) {
      clearTimeout(debounceTimerRef.current);
    }

    debounceTimerRef.current = setTimeout(() => {
      computeDiff();
    }, DEBOUNCE_MS);

    return () => {
      if (debounceTimerRef.current) {
        clearTimeout(debounceTimerRef.current);
      }
    };
  }, [currentSequence, currentAnnotations, status, computeDiff]);

  useEffect(() => {
    fetchHeadContent();
  }, [fetchHeadContent]);

  useEffect(() => {
    return () => {
      headFetchIdRef.current += 1;
      requestIdRef.current += 1;
      const closeReason = consumeSequenceTabCloseGesture(tabId);
      headFetchAbortRef.current?.abort(closeReason);
      headFetchCloseBindingRef.current?.();
      headFetchCloseBindingRef.current = null;
      headFetchAbortRef.current = null;
      if (debounceTimerRef.current) {
        clearTimeout(debounceTimerRef.current);
        debounceTimerRef.current = null;
      }
      headContentRef.current = null;
      headSequenceRef.current = null;
      headAnnotationsRef.current = null;
    };
  }, [tabId]);

  const refreshHeadContent = useCallback(() => {
    setDiffResult(null);
    setAnnotationDiff(null);
    fetchHeadContent();
  }, [fetchHeadContent]);

  const recomputeNow = useCallback(() => {
    if (debounceTimerRef.current) {
      clearTimeout(debounceTimerRef.current);
      debounceTimerRef.current = null;
    }
    computeDiff();
  }, [computeDiff]);

  return {
    diffResult,
    annotationDiff,
    status,
    headSequence: headSequenceRef.current,
    refreshHeadContent,
    recomputeNow,
  };
}
