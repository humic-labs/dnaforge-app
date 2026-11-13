// @vitest-environment node

import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { constants as osConstants, tmpdir } from 'node:os';
import { join } from 'node:path';
import { query as claudeQuery } from '@anthropic-ai/claude-agent-sdk';
import { describe, expect, it } from 'vitest';

import {
  CLAUDE_BUNDLED_RUNTIME_VERSION,
  CLAUDE_RUNTIME_TOOL_POLICY,
} from '../native-tool-capabilities';
import { subprocessEnv } from '../subprocess-env';

describe('bundled Claude runtime tool discovery', () => {
  it('classifies every tool emitted by the exact SDK runtime init event', async () => {
    const abortController = new AbortController();
    let fixtureRoot: string | undefined;
    let fixtureRemovalCompleted = false;
    let discoveredVersion: string | undefined;
    let discoveredTools: string[] | undefined;
    let stream: ReturnType<typeof claudeQuery> | undefined;
    let primaryPresent = false;
    let primaryValue: unknown = undefined;
    let cleanupPresent = false;
    let firstCleanupValue: unknown = undefined;
    const cleanupFacts: Array<{ phase: string; error: unknown }> = [];
    let cleanupFactsOmitted = false;
    let attentionAttempted = false;
    const children: Array<{
      child: ChildProcessWithoutNullStreams;
      closed: Promise<void>;
      lifecycle: {
        closedObserved: boolean;
        code: number | null;
        signal: NodeJS.Signals | null;
        termAttempted: boolean;
        termSent: boolean;
        coalescedTermRequests: number;
        expectedAbortErrors: number;
      };
    }> = [];
    const appendFact = (phase: string, error: unknown) => {
      if (cleanupFacts.length < 8) cleanupFacts.push({ phase, error });
      else cleanupFactsOmitted = true;
    };
    const recordCleanup = (phase: string, error: unknown) => {
      if (!cleanupPresent) {
        cleanupPresent = true;
        firstCleanupValue = error;
      }
      appendFact(phase, error);
      if (attentionAttempted) return;
      attentionAttempted = true;
      try {
        console.error('SDK_RUNTIME_TEST_CLEANUP_ATTENTION', {
          phase,
          fixtureRoot,
          primaryPresent,
          childPids: children.slice(0, 8).map(({ child }) => child.pid),
        });
      } catch (reportError) {
        appendFact('attention-report', reportError);
      }
    };

    try {
      fixtureRoot = mkdtempSync(join(tmpdir(), 'dnaforge-runtime-tool-discovery-'));
      const configDir = join(fixtureRoot, 'config');
      const secureStorageDir = join(fixtureRoot, 'secure-storage');
      mkdirSync(configDir);
      mkdirSync(secureStorageDir);
      stream = claudeQuery({
        prompt: 'Report runtime capabilities only.',
        options: {
          abortController,
          maxTurns: 1,
          permissionMode: 'dontAsk',
          settingSources: [],
          cwd: fixtureRoot,
          env: {
            ...subprocessEnv('claude'),
            ANTHROPIC_API_KEY: 'test-only-not-a-secret',
            ANTHROPIC_BASE_URL: 'http://127.0.0.1:9',
            CLAUDE_CONFIG_DIR: configDir,
            CLAUDE_SECURESTORAGE_CONFIG_DIR: secureStorageDir,
          },
          spawnClaudeCodeProcess: ({ command, args, cwd, env, signal }) => {
            const child = spawn(command, args, {
              cwd,
              env,
              signal,
              stdio: ['pipe', 'pipe', 'pipe'],
            });
            const lifecycle = {
              closedObserved: false,
              code: null as number | null,
              signal: null as NodeJS.Signals | null,
              termAttempted: false,
              termSent: false,
              coalescedTermRequests: 0,
              expectedAbortErrors: 0,
            };
            const closed = new Promise<void>((resolve) => {
              child.on('error', (error) => {
                if (
                  signal?.aborted &&
                  error.name === 'AbortError' &&
                  'code' in error &&
                  error.code === 'ABORT_ERR'
                ) {
                  lifecycle.expectedAbortErrors += 1;
                  return;
                }
                recordCleanup('child-error', error);
              });
              child.once('close', (code, signal) => {
                lifecycle.closedObserved = true;
                lifecycle.code = code;
                lifecycle.signal = signal;
                resolve();
              });
            });
            children.push({ child, closed, lifecycle });
            const normalKill = child.kill.bind(child);
            child.kill = (requestedSignal = 'SIGTERM') => {
              if (child.exitCode !== null || child.signalCode !== null) return false;
              if (
                requestedSignal !== 'SIGTERM' &&
                requestedSignal !== osConstants.signals.SIGTERM
              ) {
                recordCleanup(
                  'blocked-sdk-signal',
                  new Error(
                    `SDK requested forbidden signal ${String(requestedSignal).slice(0, 32)}`
                  )
                );
                return false;
              }
              if (lifecycle.termAttempted) {
                lifecycle.coalescedTermRequests += 1;
                return false;
              }
              lifecycle.termAttempted = true;
              try {
                lifecycle.termSent = normalKill('SIGTERM');
                return lifecycle.termSent;
              } catch (error) {
                recordCleanup('normal-term', error);
                return false;
              }
            };
            child.stderr.resume();
            return child;
          },
        },
      });
      for await (const message of stream) {
        if (message.type !== 'system' || message.subtype !== 'init') continue;
        discoveredVersion = message.claude_code_version;
        discoveredTools = message.tools;
        abortController.abort();
        break;
      }
      expect(discoveredVersion).toBe(CLAUDE_BUNDLED_RUNTIME_VERSION);
      expect(discoveredTools).toEqual(Object.keys(CLAUDE_RUNTIME_TOOL_POLICY));
      expect(children).toHaveLength(1);
    } catch (error) {
      primaryPresent = true;
      primaryValue = error;
    } finally {
      try {
        abortController.abort();
      } catch (error) {
        recordCleanup('abort', error);
      }
      try {
        stream?.close();
      } catch (error) {
        recordCleanup('query-close', error);
      }
      for (const owned of children) {
        try {
          await owned.closed;
        } catch (error) {
          recordCleanup('child-close', error);
        }
      }
    }

    for (const { child, lifecycle } of children) {
      try {
        expect(lifecycle.closedObserved).toBe(true);
        expect(child.exitCode !== null || child.signalCode !== null).toBe(true);
        const pid = child.pid;
        expect(pid).toBeGreaterThan(0);
        if (pid === undefined) throw new Error('SDK child never acquired a PID');
        let alive = false;
        try {
          process.kill(pid, 0);
          alive = true;
        } catch (error) {
          expect(error).toMatchObject({ code: 'ESRCH' });
        }
        expect(alive).toBe(false);
      } catch (error) {
        recordCleanup('child-exit-oracle', error);
      }
    }
    if (!primaryPresent && !cleanupPresent && fixtureRoot !== undefined) {
      try {
        rmSync(fixtureRoot, { recursive: true, force: true });
        fixtureRemovalCompleted = true;
      } catch (error) {
        recordCleanup('fixture-remove', error);
      }
    }
    if (primaryPresent || cleanupPresent) {
      try {
        console.error('Runtime discovery fixture cleanup state', {
          fixtureRoot,
          fixtureRemovalCompleted,
          primaryPresent,
          cleanupPresent,
          cleanupFacts,
          cleanupFactsOmitted,
          childClosures: children.slice(0, 8).map(({ child, lifecycle }) => ({
            pid: child.pid,
            ...lifecycle,
          })),
        });
      } catch (error) {
        recordCleanup('final-report', error);
      }
    }
    if (primaryPresent) throw primaryValue;
    if (cleanupPresent) throw firstCleanupValue;
  }, 15_000);
});
