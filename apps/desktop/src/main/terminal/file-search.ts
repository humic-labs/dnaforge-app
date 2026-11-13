import { realpath } from 'node:fs/promises';
import { isAbsolute, normalize, relative, sep } from 'node:path';
import { escape, globIterate } from 'glob';
import { z } from 'zod';
import { isPathInsideAnyBoundary } from '../../shared/path-boundary';
import type {
  TerminalFileSearchRequest,
  TerminalFileSearchResult,
} from '../../shared/terminal-ipc';

const requestSchema = z
  .object({
    requestId: z.string().uuid(),
    roots: z.array(z.string().min(1).max(32_768).refine(isAbsolute)).max(32),
    query: z
      .string()
      .max(1024)
      .refine((value) => !/\p{Cc}/u.test(value)),
  })
  .strict();
interface SearchJob {
  requestId: string;
  sessionId: string;
  controller: AbortController;
}

export class TerminalFileSearch {
  private readonly jobs = new Map<number, SearchJob>();

  constructor(
    private readonly options: {
      admitRoot(path: string): Promise<string>;
      captureRoot?(path: string): () => void;
      maxResults?: number;
      timeoutMs?: number;
    }
  ) {}

  cancel(owner: number, requestId?: string): void {
    const job = this.jobs.get(owner);
    if (job && (requestId === undefined || requestId === job.requestId)) job.controller.abort();
  }

  release(owner: number, sessionId?: string): void {
    const job = this.jobs.get(owner);
    if (job && (sessionId === undefined || sessionId === job.sessionId)) job.controller.abort();
  }

  async find(
    owner: number,
    sessionId: string,
    input: TerminalFileSearchRequest
  ): Promise<TerminalFileSearchResult> {
    const request = requestSchema.parse(input);
    this.cancel(owner);
    const job: SearchJob = {
      requestId: request.requestId,
      sessionId,
      controller: new AbortController(),
    };
    this.jobs.set(owner, job);
    const { signal } = job.controller;
    const paths = new Set<string>();
    let incomplete = false;
    let stopped = false;
    let rootGuards: Array<() => void> = [];
    const timer = setTimeout(() => {
      incomplete = stopped = true;
      job.controller.abort();
    }, this.options.timeoutMs ?? 5000);
    timer.unref();
    let abort!: () => void;
    const aborted = new Promise<never>((_resolve, reject) => {
      abort = () => reject(new Error('Terminal filename search was canceled.'));
      signal.addEventListener('abort', abort, { once: true });
    });
    const result = (): TerminalFileSearchResult => {
      if (!(signal.aborted && !stopped)) for (const guard of rootGuards) guard();
      return {
        requestId: request.requestId,
        paths: signal.aborted && !stopped ? [] : [...paths].sort(),
        incomplete,
        cancelled: signal.aborted && !stopped,
      };
    };
    try {
      if (isAbsolute(request.query)) return result();
      let query = normalize(request.query.trim());
      if (sep === '\\') query = query.replaceAll('\\', '/');
      query = query.replace(/^(?:(?:\.\.?)[/])+/, '');
      if (!query || query === '.' || query === '..' || !request.roots.length) return result();
      const roots = [
        ...new Set(
          await Promise.race([
            Promise.all(request.roots.map((root) => this.options.admitRoot(root))),
            aborted,
          ])
        ),
      ];
      signal.throwIfAborted();
      rootGuards = roots.map((root) => this.options.captureRoot?.(root) ?? (() => undefined));
      const assertRoots = () => {
        signal.throwIfAborted();
        for (const guard of rootGuards) guard?.();
      };
      const exact = `**/${escape(query)}`;
      const partial = `**/*${query
        .split('/')
        .map((part) => escape(part))
        .join('*/*')}*`;
      for (const pattern of [exact, partial]) {
        for (const root of roots) {
          assertRoots();
          for await (const path of globIterate(pattern, {
            cwd: root,
            absolute: true,
            nodir: true,
            nobrace: true,
            dot: true,
            follow: false,
            signal,
            ignore: {
              ignored: (entry) => entry.name === '.git' || entry.name === 'node_modules',
              childrenIgnored: (entry) => {
                if (
                  entry.name === '.git' ||
                  entry.name === 'node_modules' ||
                  entry.isSymbolicLink()
                )
                  return true;
                if (relative(root, entry.fullpath()).split(sep).length > 64) {
                  incomplete = true;
                  return true;
                }
                return false;
              },
            },
          })) {
            assertRoots();
            const canonical = await Promise.race([realpath(path).catch(() => null), aborted]);
            assertRoots();
            if (canonical && isPathInsideAnyBoundary(canonical, roots)) paths.add(canonical);
            if (paths.size >= (this.options.maxResults ?? 100)) {
              incomplete = stopped = true;
              job.controller.abort();
              return result();
            }
          }
        }
        assertRoots();
        if (paths.size) return result();
      }
      return result();
    } catch (error) {
      if (signal.aborted) return result();
      throw error;
    } finally {
      clearTimeout(timer);
      signal.removeEventListener('abort', abort);
      if (this.jobs.get(owner) === job) this.jobs.delete(owner);
    }
  }
}
