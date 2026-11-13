import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';
import * as policy from '@waypoint/analytics-policy';
import * as registry from './analytics-registry.generated';
import * as workflows from './scientific-workflow-vocab';
import * as aiTurns from './ai-turn-telemetry';
import { sanitizeClosedBetaProperties } from './analytics-allowlist';

type Sanitizer = (value: Record<string, unknown>) => Record<string, unknown>;
const SOURCE_DIGESTS: Record<string, string> = {
  'v0.9.7': '508a78c7f9b4a3008bee49b35a9046584a95f63692e0517ecfee8948c745241f',
  'v0.9.12': '231a48a7b1cb67e308cf097acce29d688f4a17f2a6069eb8db8a6d42b9536fa8',
};

function historicalSanitizer(version: string): Sanitizer {
  const source = readFileSync(
    resolve(process.cwd(), 'src/shared/__fixtures__/updater-sanitizer', `${version}.txt`),
    'utf8'
  );
  expect(createHash('sha256').update(source).digest('hex')).toBe(SOURCE_DIGESTS[version]);
  const compiled = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  });
  const dependencies: Record<string, unknown> = {
    '@waypoint/analytics-policy': policy,
    './analytics-registry.generated': registry,
    './scientific-workflow-vocab': workflows,
    './ai-turn-telemetry': aiTurns,
  };
  const exports: Record<string, unknown> = {};
  runInNewContext(
    compiled.outputText,
    {
      exports,
      require: (name: string) => {
        if (!(name in dependencies))
          throw new Error(`Unqualified historical fixture import: ${name}`);
        return dependencies[name];
      },
    },
    { timeout: 1000 }
  );
  const sanitizer = exports.sanitizeClosedBetaProperties;
  if (typeof sanitizer !== 'function') throw new Error('Historical sanitizer missing.');
  return (value) => sanitizer(value);
}

const payload = {
  feature_area: 'reliability',
  stage: 'install',
  error_class: 'update_install_did_not_advance',
  error_code: 'same_version_relaunch',
};

describe('historical updater stage attribution  U-C)', () => {
  it('v0.9.7 strips install stage while retaining the safe error class/code', () => {
    const sanitize = historicalSanitizer('v0.9.7');
    expect(sanitize(payload)).toEqual({
      feature_area: 'reliability',
      error_class: payload.error_class,
      error_code: payload.error_code,
    });
    expect(
      sanitize({ ...payload, message: '/private/native-error?token=secret' })
    ).not.toHaveProperty('message');
  });

  it('v0.9.12 and current source accept check/download/install without dropping the stage', () => {
    for (const sanitize of [historicalSanitizer('v0.9.12'), sanitizeClosedBetaProperties]) {
      for (const stage of ['check', 'download', 'install']) {
        expect(sanitize({ ...payload, stage })).toEqual({ ...payload, stage });
      }
    }
  });

  it('current download episode fields survive while private candidate metadata cannot leave', () => {
    const safe = {
      version: '2.1.0',
      operation_id: '550e8400-e29b-41d4-a716-446655440000',
      occurred_at_ms: 1234,
      download_duration_ms: 125,
    };
    expect(
      sanitizeClosedBetaProperties({
        ...safe,
        sha512: 'private-candidate',
        path: '/private/installer',
        message: 'private native error',
      })
    ).toEqual(safe);
    expect(registry.CLOSED_BETA_EVENT_PROPERTIES.app_update_downloaded).toEqual(
      expect.arrayContaining(Object.keys(safe))
    );
  });
});
