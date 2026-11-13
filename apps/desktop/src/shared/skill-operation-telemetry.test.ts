import { describe, expect, it } from 'vitest';
import { sanitizeClosedBetaProperties } from './analytics-allowlist';
import { skillOperationProperties } from './skill-operation-telemetry';
const observation = '10000000-0000-4000-8000-000000000001';

describe('Skills closed observation vocabulary', () => {
  it('keeps installed, stored disabled, effective, runtime, instructions and task usefulness separate', () => {
    const committed = skillOperationProperties(
      observation,
      'update',
      'mutation',
      'manifest_committed',
      {
        installed: 'installed',
        storedEnablement: 'disabled',
        authority: 'committed_domain_receipt',
      },
      100,
      'native_domain'
    );
    expect(committed).toMatchObject({
      skills_installed: 'installed',
      skills_stored_enablement: 'disabled',
      skills_effective_enablement: 'not_attested',
      skills_runtime_discovery: 'not_attested',
      skills_instruction_load: 'not_attested',
      skills_task_reuse: 'not_attested',
      occurred_at_ms: 100,
      skills_occurrence_clock: 'native_domain',
    });
    const loaded = skillOperationProperties(
      observation,
      'instruction_load',
      'instruction',
      'instruction_returned',
      {
        instruction: 'full',
        runtime: 'discovered',
        effectiveEnablement: 'enabled',
        observedAtMs: 90,
      },
      110
    );
    expect(loaded).toMatchObject({
      skills_installed: 'not_attested',
      skills_stored_enablement: 'not_attested',
      skills_task_reuse: 'not_attested',
      skills_observed_at_ms: 90,
      occurred_at_ms: 110,
    });
  });
  it('drops hostile dynamic facets and extra private fields rather than converting them to strings', () => {
    const hostile = {
      host: '/private/skill',
      scope: 'https://private.invalid',
      source: 'customer-name',
      authority: 'revision-a',
      instructions: 'SECRET BODY',
      query: 'SECRET QUERY',
      nativeId: 'raw-install-42',
      taskReuse: 'useful',
      observedAtMs: Infinity,
    };

    const properties = Reflect.apply(skillOperationProperties, undefined, [
      observation,
      'save',
      'owner_return',
      'accepted',
      hostile,
      10,
    ]);
    expect(properties).toMatchObject({
      skills_host: 'unknown',
      skills_scope: 'unknown',
      skills_source: 'unknown',
      skills_authority: 'not_attested',
      skills_task_reuse: 'not_attested',
      skills_observation_clock: 'unknown',
    });
    expect(properties).not.toHaveProperty('skills_observed_at_ms');
    expect(JSON.stringify(properties)).not.toMatch(
      /SECRET|private|customer|raw-install|revision-a/u
    );
  });
  it.each([NaN, Infinity, -1, '90', null])(
    'does not invent an observed clock from %s',
    (observedAtMs) => {
      const p = Reflect.apply(skillOperationProperties, undefined, [
        observation,
        'review',
        'owner_return',
        'reviewed',
        { observedAtMs },
        10,
      ]);
      expect(p.skills_observation_clock).toBe('unknown');
      expect(p).not.toHaveProperty('skills_observed_at_ms');
    }
  );
  it('uses the actual allowlist to reject dynamic or useful-task claims and raw identity/content fields', () => {
    const valid = skillOperationProperties(
      observation,
      'instruction_load',
      'instruction',
      'instruction_returned',
      {
        host: 'codex-sdk',
        scope: 'workspace',
        source: 'catalog',
        authority: 'approved_locator_read',
        instruction: 'full',
        observedAtMs: 90,
      },
      100
    );
    expect(sanitizeClosedBetaProperties({ ...valid })).toMatchObject(valid);
    const hostile = sanitizeClosedBetaProperties({
      ...valid,
      skills_host: 'PRIVATE HOST',
      skills_scope: '/private/work',
      skills_source: 'PRIVATE QUERY',
      skills_result: 'PRIVATE RAW ERROR',
      skills_task_reuse: 'useful',
      native_id: 'private-native',
      skill_id: 'private-native',
      instructions: 'PRIVATE BODY',
      path: '/private/work',
      url: 'https://private.invalid',
      revision: 'a'.repeat(40),
      digest: 'b'.repeat(64),
    });
    for (const key of [
      'skills_host',
      'skills_scope',
      'skills_source',
      'skills_result',
      'skills_task_reuse',
      'native_id',
      'skill_id',
      'instructions',
      'path',
      'url',
      'revision',
      'digest',
    ])
      expect(hostile).not.toHaveProperty(key);
    expect(JSON.stringify(hostile)).not.toMatch(/PRIVATE|private|useful/u);
  });
});
