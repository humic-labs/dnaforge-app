// @vitest-environment node

import { describe, expect, it } from 'vitest';
import { resolveDevAiEnvKey, type DevAiEnvKeyLookup } from './dev-ai-env-keys';

function lookup(over: Partial<DevAiEnvKeyLookup> = {}): DevAiEnvKeyLookup {
  return { enabled: true, fileEnv: {}, processEnv: {}, ...over };
}

describe('resolveDevAiEnvKey', () => {
  it('never bakes file or process credentials into a qualification build', () => {
    for (const provider of ['ANTHROPIC', 'OPENAI', 'GOOGLE', 'XAI', 'DEEPSEEK']) {
      expect(
        resolveDevAiEnvKey(
          `${provider}_API_KEY`,
          lookup({
            fileEnv: { [`WAYPOINT_DEV_${provider}_API_KEY`]: 'inert-file-marker' },
            processEnv: {
              DNAFORGE_AI_QUALIFICATION_BUILD: '1',
              [`WAYPOINT_DEV_${provider}_API_KEY`]: 'inert-process-marker',
            },
          }),
          'inert-fallback-marker'
        )
      ).toBe('');
    }
  });

  it('returns empty when the dev escape hatch is disabled — even if every source is set', () => {
    const value = resolveDevAiEnvKey(
      'ANTHROPIC_API_KEY',
      {
        enabled: false,
        fileEnv: { WAYPOINT_DEV_ANTHROPIC_API_KEY: 'scoped', ANTHROPIC_API_KEY: 'bare' },
        processEnv: { WAYPOINT_DEV_ANTHROPIC_API_KEY: 'scoped', ANTHROPIC_API_KEY: 'bare' },
      },
      'fallback'
    );
    expect(value).toBe('');
  });

  it('prefers the app-scoped WAYPOINT_DEV_* name over the bare global (de-bare-naming)', () => {
    const value = resolveDevAiEnvKey(
      'ANTHROPIC_API_KEY',
      lookup({
        fileEnv: { WAYPOINT_DEV_ANTHROPIC_API_KEY: 'app-scoped', ANTHROPIC_API_KEY: 'bare-leak' },
      })
    );
    expect(value).toBe('app-scoped');
  });

  it('reads the app-scoped name from processEnv when not in fileEnv', () => {
    const value = resolveDevAiEnvKey(
      'OPENAI_API_KEY',
      lookup({ processEnv: { WAYPOINT_DEV_OPENAI_API_KEY: 'from-process' } })
    );
    expect(value).toBe('from-process');
  });

  it('NEVER reads the bare global (fully de-bare-named) — falls through to the literal fallback', () => {
    const value = resolveDevAiEnvKey(
      'ANTHROPIC_API_KEY',
      lookup({
        fileEnv: { ANTHROPIC_API_KEY: 'bare-file-leak' },
        processEnv: { ANTHROPIC_API_KEY: 'bare-process-leak' },
      }),
      'fallback'
    );
    expect(value).toBe('fallback');
  });

  it('honors source precedence: scoped.fileEnv > scoped.processEnv > fallback (bare never consulted)', () => {
    const all = lookup({
      fileEnv: { WAYPOINT_DEV_X_API_KEY: 'sf', X_API_KEY: 'bf' },
      processEnv: { WAYPOINT_DEV_X_API_KEY: 'sp', X_API_KEY: 'bp' },
    });
    expect(resolveDevAiEnvKey('X_API_KEY', all, 'fb')).toBe('sf');

    const noScopedFile = lookup({
      fileEnv: { X_API_KEY: 'bf' },
      processEnv: { WAYPOINT_DEV_X_API_KEY: 'sp', X_API_KEY: 'bp' },
    });
    expect(resolveDevAiEnvKey('X_API_KEY', noScopedFile, 'fb')).toBe('sp');

    const onlyBare = lookup({ fileEnv: { X_API_KEY: 'bf' }, processEnv: { X_API_KEY: 'bp' } });
    expect(resolveDevAiEnvKey('X_API_KEY', onlyBare, 'fb')).toBe('fb');
  });

  it('uses the literal fallback (e.g. the CI placeholder key) when enabled but nothing is set', () => {
    expect(resolveDevAiEnvKey('ANTHROPIC_API_KEY', lookup(), 'sk-ant-e2e-test-key-not-real')).toBe(
      'sk-ant-e2e-test-key-not-real'
    );
  });

  it('returns empty when enabled with no sources and no fallback', () => {
    expect(resolveDevAiEnvKey('ANTHROPIC_API_KEY', lookup())).toBe('');
  });
});
