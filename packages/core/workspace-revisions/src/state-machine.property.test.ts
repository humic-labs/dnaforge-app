import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { cwd, env } from 'node:process';

import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import {
  readStateMachineCommandCoverage,
  resetStateMachineCommandCoverage,
  STATE_MACHINE_COMMAND_KINDS,
  initialStateMachine,
  stateMachineCommandArbitraries,
} from './state-machine-model.test-support';
import { parseStateMachineSeedFixture } from './testing-public';

const rawSeeds: unknown = JSON.parse(
  readFileSync(new URL('../fixtures/state-machine-seeds.v1.json', import.meta.url), 'utf8')
);
const fixture = requireSeedFixture(rawSeeds);

describe('generated workspace revision state machine', () => {
  it('preserves all ten graph and authority invariants after every generated command', () => {
    resetStateMachineCommandCoverage();
    const replaySeed = parseReplaySeed(env.FC_SEED);
    const seeds = replaySeed === null ? fixture.seeds : [replaySeed];
    const replay = parseReplayCoordinates(env.FC_PATH);
    for (const seed of seeds) {
      runStateMachine(seed, replay, replay === null ? fixture.numRunsPerSeed : 1);
    }
    expect(seeds.length).toBeGreaterThan(0);
    if (replay === null) {
      expect(readStateMachineCommandCoverage()).toEqual([...STATE_MACHINE_COMMAND_KINDS].sort());
    }
  });
});

interface ReplayCoordinates {
  readonly propertyPath: string;
  readonly commandPath: string;
}

function runStateMachine(seed: number, replay: ReplayCoordinates | null, numRuns: number): void {
  const commands = fc.commands([...stateMachineCommandArbitraries()], {
    maxCommands: fixture.maxCommands,
    ...(replay === null ? {} : { replayPath: replay.commandPath }),
  });
  const property = fc.property(commands, (sequence) => {
    fc.modelRun(initialStateMachine, sequence);
  });
  const details = fc.check(property, {
    seed,
    numRuns,
    ...(replay === null ? {} : { path: replay.propertyPath }),
  });
  if (!details.failed) return;

  const counterexamplePath = details.counterexamplePath ?? '';
  const trace =
    details.counterexample === null ? '<no command trace>' : String(details.counterexample[0]);
  const commandPath = /replayPath="([^"]*)"/u.exec(trace)?.[1] ?? '';
  const replayCommand =
    `FC_SEED=${details.seed} FC_PATH='${counterexamplePath}|${commandPath}' ` +
    'pnpm --filter @waypoint/workspace-revisions test -- state-machine.property.test.ts';
  const failureReceiptPath =
    env.FC_FAILURE_RECEIPT_PATH ??
    resolve(cwd(), 'test-results/workspace-revisions/state-machine-failure.json');
  const failureReceipt = {
    formatVersion: 1,
    seed: details.seed,
    propertyPath: counterexamplePath,
    commandPath,
    minimizedActionTrace: trace,
    replayCommand,
    error:
      details.errorInstance instanceof Error
        ? details.errorInstance.message
        : (details.error ?? 'Generated state machine failed without an error payload.'),
  };
  mkdirSync(dirname(failureReceiptPath), { recursive: true });
  writeFileSync(failureReceiptPath, `${JSON.stringify(failureReceipt, null, 2)}\n`, 'utf8');
  console.error(`STATE_MACHINE_REPLAY ${replayCommand}`);
  console.error(`STATE_MACHINE_ACTION_TRACE ${trace}`);
  console.error(`STATE_MACHINE_FAILURE_RECEIPT ${failureReceiptPath}`);
  if (details.errorInstance instanceof Error) throw details.errorInstance;
  throw new Error(details.error ?? 'Generated state machine failed without an error payload.');
}

function parseReplaySeed(value: string | undefined): number | null {
  if (value === undefined) return null;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) throw new Error(`Invalid FC_SEED: ${value}`);
  return parsed;
}

function parseReplayCoordinates(value: string | undefined): ReplayCoordinates | null {
  if (value === undefined) return null;
  const separator = value.indexOf('|');
  if (separator < 0) throw new Error('FC_PATH must contain property and command paths.');
  return {
    propertyPath: value.slice(0, separator),
    commandPath: value.slice(separator + 1),
  };
}

function requireSeedFixture(input: unknown) {
  const parsed = parseStateMachineSeedFixture(input);
  if (!parsed) throw new Error('Invalid state-machine seed fixture.');
  return parsed;
}
