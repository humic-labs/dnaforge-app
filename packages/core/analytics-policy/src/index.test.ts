import { describe, expect, it } from 'vitest';
import {
  ANALYTICS_CONSENT_VERSION,
  DESKTOP_ANALYTICS_DISCLOSURE,
  DESKTOP_ANALYTICS_OPT_IN_MESSAGE,
  DESKTOP_ANALYTICS_TOAST_MESSAGE,
  DESKTOP_SESSION_RECORDING_CONFIG,
  SAFE_AUTOCAPTURE_CONFIG,
  SAFE_POSTHOG_PRIVACY_CONFIG,
  WEB_ANALYTICS_DISCLOSURE,
  acceptIdentityContext,
  resolveConsentPolicy,
  classifyInternalOperator,
  classifyInternalOperatorWithDigests,
  INTERNAL_OPERATOR_EMAIL_DIGESTS,
  INTERNAL_OPERATORS,
  internalOperatorEmailDigest,
  resolveWebTelemetryActor,
  sanitizeAnalyticsUrl,
  sanitizeSdkEvent,
  type AnalyticsIdentityContext,
} from './index';

describe('internal operator classification', () => {
  it('maps operator names and hashed operator emails to the bounded enum, never the email', () => {
    const digests = new Map([
      [internalOperatorEmailDigest('maintainer@example.com'), 'operator_a' as const],
    ]);
    expect(classifyInternalOperatorWithDigests('  Maintainer@Example.com  ', digests)).toBe(
      'operator_a'
    );
    expect(classifyInternalOperatorWithDigests('operator_a', digests)).toBe('operator_a');
    expect(classifyInternalOperatorWithDigests('OPERATOR_B', digests)).toBe('operator_b');
    expect(classifyInternalOperatorWithDigests('user@example.com', digests)).toBeUndefined();
    expect(classifyInternalOperatorWithDigests('ci', digests)).toBeUndefined();
    expect(classifyInternalOperatorWithDigests(42, digests)).toBeUndefined();
  });

  it('hashes the normalized email with SHA-256', () => {
    expect(internalOperatorEmailDigest('abc')).toBe(
      'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad'
    );
  });

  it('ships only well-formed digests of known operators', () => {
    expect(INTERNAL_OPERATOR_EMAIL_DIGESTS.size).toBe(0);
    for (const [digest, operator] of INTERNAL_OPERATOR_EMAIL_DIGESTS) {
      expect(digest).toMatch(/^[0-9a-f]{64}$/);
      expect(INTERNAL_OPERATORS).toContain(operator);
    }
    expect(classifyInternalOperator('operator_a')).toBe('operator_a');
    expect(classifyInternalOperator('user@example.com')).toBeUndefined();
  });
});

describe('web telemetry actor policy', () => {
  it.each([
    ['production customer', 'production', 'prod', undefined, 'user'],
    ['closed beta customer', 'production', 'closed_beta', undefined, 'user'],
    ['local test', 'test', 'unknown', undefined, 'dev'],
    ['Vercel preview', 'preview', 'preview', undefined, 'dev'],
    ['production preview channel', 'production', 'preview', undefined, 'dev'],
    ['maintainer override', 'production', 'prod', 'maintainer', 'maintainer'],
    ['CI override', 'production', 'prod', 'ci', 'ci'],
    ['customer cannot override a non-production runtime', 'test', 'prod', 'user', 'dev'],
  ] as const)('%s', (_name, environment, releaseChannel, explicitActor, expected) => {
    expect(resolveWebTelemetryActor({ environment, releaseChannel, explicitActor })).toBe(expected);
  });
});

describe('analytics consent v3 policy', () => {
  it.each([
    ['desktop', 'opt_out', 'false', null, null, false, false, 'false', '3'],
    ['desktop', 'opt_out', 'true', '3', null, true, false, 'true', '3'],
    ['desktop', 'opt_out', 'true', '2', null, true, true, 'true', '3'],
    ['desktop', 'opt_out', 'true', '1', null, true, true, 'true', '3'],
    ['desktop', 'opt_out', null, null, null, true, true, 'true', '3'],
    ['desktop', 'opt_out', 'corrupt', '3', null, true, true, 'true', '3'],
    ['desktop', 'opt_in', 'false', '3', 'explicit', false, false, 'false', '3'],
    ['desktop', 'opt_in', 'true', '3', 'explicit', true, false, 'true', '3'],
    ['desktop', 'opt_in', 'true', '3', 'default', false, true, null, null],
    ['desktop', 'opt_in', 'true', '3', null, false, true, null, null],
    ['desktop', 'opt_in', 'true', '2', 'explicit', false, true, null, null],
    ['desktop', 'opt_in', null, null, null, false, true, null, null],
    ['desktop', undefined, 'true', '3', 'default', false, true, null, null],
    ['web', undefined, 'false', '1', null, false, false, 'false', '3'],
    ['web', undefined, 'true', '3', null, true, false, 'true', '3'],
    ['web', undefined, 'true', '2', null, false, true, null, null],
    ['web', undefined, 'true', '1', null, false, true, null, null],
    ['web', undefined, null, null, null, false, true, null, null],
  ] as const)(
    '%s regime=%s consent=%s version=%s basis=%s',
    (
      surface,
      regime,
      storedConsent,
      storedVersion,
      storedBasis,
      enabled,
      needsDisclosure,
      consent,
      version
    ) => {
      expect(
        resolveConsentPolicy({ surface, regime, storedConsent, storedVersion, storedBasis })
      ).toEqual({ enabled, needsDisclosure, consent, version });
    }
  );

  it('publishes one consent schema version', () => {
    expect(ANALYTICS_CONSENT_VERSION).toBe('3');
  });

  it('names the Settings control in the opt-out notice and asks first in opt-in regions', () => {
    expect(DESKTOP_ANALYTICS_TOAST_MESSAGE).toBe(
      'DNAForge shares usage analytics and crash reports to help improve the app. You can turn this off in Settings.'
    );
    expect(DESKTOP_ANALYTICS_OPT_IN_MESSAGE).toMatch(/nothing is shared unless you allow it/i);
    expect(DESKTOP_ANALYTICS_OPT_IN_MESSAGE).toMatch(/crash reports/i);
  });

  it('describes rich capture, masked replay, crash reports, and a labeled person', () => {
    expect(DESKTOP_ANALYTICS_DISCLOSURE).toMatch(/workflow events/i);
    expect(DESKTOP_ANALYTICS_DISCLOSURE).toMatch(/session replay with all text, typing/i);
    expect(DESKTOP_ANALYTICS_DISCLOSURE).toMatch(/clicks/i);
    expect(DESKTOP_ANALYTICS_DISCLOSURE).toMatch(/never which key/i);
    expect(DESKTOP_ANALYTICS_DISCLOSURE).toMatch(/crash reports/i);
    expect(DESKTOP_ANALYTICS_DISCLOSURE).toMatch(/labeled account identity/i);
    expect(WEB_ANALYTICS_DISCLOSURE).toMatch(/optional analytics cookies/i);
    expect(WEB_ANALYTICS_DISCLOSURE).toMatch(/this website/i);
    expect(WEB_ANALYTICS_DISCLOSURE).not.toMatch(/posthog/i);
    expect(WEB_ANALYTICS_DISCLOSURE).not.toMatch(/session replay/i);
    expect(WEB_ANALYTICS_DISCLOSURE.length).toBeLessThan(160);

    for (const disclosure of [DESKTOP_ANALYTICS_DISCLOSURE, WEB_ANALYTICS_DISCLOSURE]) {
      expect(disclosure).not.toMatch(/content upload/i);
      expect(disclosure).not.toMatch(/full file bytes/i);
      expect(disclosure).not.toMatch(/private telemetry content projection/i);
    }
  });
});

describe('safe PostHog configuration', () => {
  it('captures safe interactions but never copied text or arbitrary element attributes', () => {
    expect(SAFE_AUTOCAPTURE_CONFIG).toEqual({
      dom_event_allowlist: ['click', 'change', 'submit', 'input'],
      element_allowlist: [
        'a',
        'button',
        'form',
        'input',
        'select',
        'textarea',
        'label',
        'div',
        'span',
        'li',
        'summary',
      ],
      capture_copied_text: false,
      element_attribute_ignorelist: ['value'],
    });
  });

  it('enables flags, experiments, replay-friendly unmasking, and rageclicks', () => {
    expect(SAFE_POSTHOG_PRIVACY_CONFIG).toEqual({
      advanced_disable_feature_flags: false,
      advanced_disable_feature_flags_on_first_load: false,
      disable_web_experiments: false,
      disable_surveys: true,
      disable_conversations: true,
      disable_product_tours: true,
      mask_all_element_attributes: false,
      mask_all_text: false,
      mask_personal_data_properties: false,
      save_referrer: true,
      save_campaign_params: true,
      capture_performance: true,
      rageclick: true,
    });
  });
});

describe('desktop session replay configuration', () => {
  it('masks every input and all text, blocks marked regions, and records no canvas', () => {
    expect(DESKTOP_SESSION_RECORDING_CONFIG).toMatchObject({
      maskAllInputs: true,
      maskTextSelector: '*',
      blockSelector:
        '[data-replay-block], [data-ph-no-capture], [data-analytics-block], .ph-no-capture, .rr-block',
      captureCanvas: { recordCanvas: false },
      recordHeaders: false,
      recordBody: false,
      compress_events: false,
    });
  });
});

describe('analytics URL sanitization', () => {
  it.each([
    [
      'https://dnaforge.com/designs/550e8400-e29b-41d4-a716-446655440000?token=SECRET#private',
      'web',
      'unknown',
      'https://dnaforge.com/designs/:id',
    ],
    [
      'https://user:pass@dnaforge.com/auth/callback?code=SECRET',
      'web',
      'unknown',
      'https://dnaforge.com/auth/*',
    ],
    ['https://dnaforge.com/admin/users/123', 'web', 'unknown', 'https://dnaforge.com/admin/*'],
    [
      'https://dnaforge.com/download?invite=SECRET',
      'web',
      'unknown',
      'https://dnaforge.com/download',
    ],
    ['https://dnaforge.com/', 'web', 'unknown', 'https://dnaforge.com/'],
    ['https://dnaforge.com/blog/', 'web', 'unknown', 'https://dnaforge.com/blog'],
    [
      'https://dnaforge.com/blog/best-ai-biology-platform?utm_source=linkedin&email=private@example.com',
      'web',
      'unknown',
      'https://dnaforge.com/blog/best-ai-biology-platform',
    ],
    ['https://dnaforge.com/blog/private-person', 'web', 'unknown', 'https://dnaforge.com/other'],
    ['https://dnaforge.com/unregistered/123', 'web', 'unknown', 'https://dnaforge.com/other'],
    [
      'https://dnaforge.com/register?email=a@b.c',
      'web',
      'unknown',
      'https://dnaforge.com/register',
    ],
    [
      'https://dnaforge.com/docs/getting-started',
      'web',
      'unknown',
      'https://dnaforge.com/docs/getting-started',
    ],
    ['https://dnaforge.com/docs/Private Notes', 'web', 'unknown', 'https://dnaforge.com/other'],
    [
      'https://dnaforge.com/invite/SECRET_TOKEN',
      'web',
      'unknown',
      'https://dnaforge.com/invite/:token',
    ],
    [
      'https://dnaforge.com/beta/install/SECRET',
      'web',
      'unknown',
      'https://dnaforge.com/beta/install/:token',
    ],
    [
      'https://dnaforge.com/project-invite/SECRET',
      'web',
      'unknown',
      'https://dnaforge.com/project-invite/:token',
    ],
    ['https://dnaforge.com/d/abc123', 'web', 'unknown', 'https://dnaforge.com/d/:id'],
    ['https://dnaforge.com/org/acme-pharma', 'web', 'unknown', 'https://dnaforge.com/org/:slug'],
    [
      'https://dnaforge.com/org/acme-pharma/members',
      'web',
      'unknown',
      'https://dnaforge.com/org/:slug/members',
    ],
    [
      'https://dnaforge.com/org/acme-pharma/private',
      'web',
      'unknown',
      'https://dnaforge.com/other',
    ],
    [
      'https://dnaforge.com/account/projects/550e8400-e29b-41d4-a716-446655440000/access',
      'web',
      'unknown',
      'https://dnaforge.com/account/projects/:id/access',
    ],
    ['mailto:person@example.com', 'web', 'unknown', 'https://dnaforge.invalid/other'],
    [null, 'web', 'unknown', 'https://dnaforge.invalid/other'],
    [
      'file:///Users/scientist/private/app/index.html?token=SECRET',
      'desktop',
      'sequence',
      'dnaforge://desktop/sequence',
    ],
    [
      'file:///Users/scientist/private/app/index.html?token=SECRET',
      'desktop',
      'private_filename',
      'dnaforge://desktop/unknown',
    ],
    ['malformed SECRET', 'web', 'unknown', 'https://dnaforge.invalid/other'],
  ] as const)('%s', (rawUrl, surface, screen, expected) => {
    expect(sanitizeAnalyticsUrl(rawUrl, surface, screen)).toBe(expected);
  });
});

describe('SDK event egress sanitizer', () => {
  it.each(['synthetic', 'private', 'unknown', 'eligible_release'])(
    'retains closed runtime provenance %s on custom SDK events',
    (classification) => {
      const event = sanitizeSdkEvent(
        { event: 'reference_observed', properties: { runtime_origin_class: classification } },
        'desktop',
        'unknown',
        { reference_observed: [] }
      );
      expect(event?.properties.runtime_origin_class).toBe(classification);
    }
  );

  it.each(
    [null, false, 3, {}, [], '', 'PRIVATE', '/private/reference.gb', 'a'.repeat(64)].map(
      (classification) => ({ classification })
    )
  )(
    'excludes malformed runtime provenance $classification from SDK events',
    ({ classification }) => {
      const event = sanitizeSdkEvent(
        { event: 'reference_observed', properties: { runtime_origin_class: classification } },
        'desktop',
        'unknown',
        { reference_observed: [] }
      );
      expect(event).not.toBeNull();
      expect(event?.properties).not.toHaveProperty('runtime_origin_class');
    }
  );

  it('keeps bounded blog attribution only for published post pageviews', () => {
    const properties = {
      distinct_id: 'anon-safe-id',
      $current_url: 'https://www.dnaforge.com/blog/best-ai-biology-platform?private=secret',
      $referrer: 'https://www.linkedin.com/in/private-person?token=secret',
      utm_source: 'linkedin',
      utm_medium: 'social',
      utm_campaign: 'private-person-campaign',
    };
    expect(sanitizeSdkEvent({ event: '$pageview', properties }, 'web')).toEqual({
      event: '$pageview',
      properties: {
        distinct_id: 'anon-safe-id',
        $current_url: 'https://www.dnaforge.com/blog/best-ai-biology-platform',
        $pathname: '/blog/best-ai-biology-platform',
        $referring_domain: 'linkedin.com',
        utm_source: 'linkedin',
        utm_medium: 'social',
        utm_campaign: 'private-person-campaign',
        blog_source: 'linkedin',
        blog_utm_source: 'linkedin',
        blog_utm_medium: 'social',
      },
    });
    expect(
      sanitizeSdkEvent(
        {
          event: '$pageview',
          properties: { ...properties, $current_url: 'https://www.dnaforge.com/download' },
        },
        'web'
      )?.properties
    ).not.toHaveProperty('blog_source');
    expect(
      sanitizeSdkEvent(
        {
          event: '$pageview',
          properties: { ...properties, utm_source: 'person@example.com', utm_medium: 'private' },
        },
        'web'
      )?.properties
    ).toEqual(expect.not.objectContaining({ blog_utm_source: expect.anything() }));
  });

  it('keeps referring domain and bounded campaign tags on every public pageview', () => {
    const sanitized = sanitizeSdkEvent(
      {
        event: '$pageview',
        properties: {
          $current_url: 'https://dnaforge.com/download?utm_source=x',
          $referrer: 'https://news.ycombinator.com/item?id=SECRET',
          utm_source: 'HackerNews',
          utm_medium: 'person@example.com',
          utm_campaign: 'launch-2026',
          utm_term: 'plasmid editor free',
        },
      },
      'web'
    );
    expect(sanitized?.properties).toMatchObject({
      $pathname: '/download',
      $referring_domain: 'news.ycombinator.com',
      utm_source: 'hackernews',
      utm_campaign: 'launch-2026',
    });
    expect(sanitized?.properties).not.toHaveProperty('utm_medium');
    expect(sanitized?.properties).not.toHaveProperty('utm_term');
    expect(sanitized?.properties).not.toHaveProperty('$referrer');
    expect(JSON.stringify(sanitized)).not.toContain('SECRET');
    expect(
      sanitizeSdkEvent(
        {
          event: '$pageview',
          properties: { $current_url: 'https://dnaforge.com/', $referrer: '$direct' },
        },
        'web'
      )?.properties.$referring_domain
    ).toBe('$direct');
    expect(
      sanitizeSdkEvent(
        {
          event: '$pageview',
          properties: {
            $current_url: 'https://dnaforge.com/',
            $referrer: 'https://www.google.com/',
          },
        },
        'desktop'
      )?.properties
    ).not.toHaveProperty('$referring_domain');
  });

  it('keeps first-touch acquisition on the person without full referrer URLs', () => {
    expect(
      sanitizeSdkEvent(
        {
          event: '$pageview',
          properties: { $current_url: 'https://dnaforge.com/' },
          $set_once: {
            $initial_referrer: 'https://www.linkedin.com/in/private-person?token=SECRET',
            $initial_referring_domain: 'www.linkedin.com',
            $initial_utm_source: 'LinkedIn',
            $initial_utm_campaign: 'person@example.com',
            $initial_current_url: 'https://dnaforge.com/invite/SECRET',
            $initial_pathname: '/invite/SECRET',
          },
        },
        'web'
      )?.$set_once
    ).toEqual({
      $initial_referring_domain: 'linkedin.com',
      $initial_utm_source: 'linkedin',
      $initial_pathname: '/invite/:token',
    });
  });

  it('names the feature flag and its bounded response', () => {
    const flag = (response: unknown) =>
      sanitizeSdkEvent(
        {
          event: '$feature_flag_called',
          properties: {
            $feature_flag: 'telemetry-click-firehose',
            $feature_flag_response: response,
          },
        },
        'desktop'
      )?.properties;
    expect(flag(true)).toMatchObject({
      $feature_flag: 'telemetry-click-firehose',
      $feature_flag_response: true,
    });
    expect(flag('variant-b')).toMatchObject({ $feature_flag_response: 'variant-b' });
    expect(flag('person@example.com')).not.toHaveProperty('$feature_flag_response');
  });

  it('keeps rage and dead clicks as structural gestures and web vitals as numbers', () => {
    const elements = [{ tag_name: 'button', nth_child: 2, nth_of_type: 1, text: 'secret.gb' }];
    expect(
      sanitizeSdkEvent({ event: '$rageclick', properties: { $elements: elements } }, 'web')
        ?.properties
    ).toEqual({ $elements: [{ tag_name: 'button', nth_child: 2, nth_of_type: 1 }] });
    expect(
      sanitizeSdkEvent(
        {
          event: '$dead_click',
          properties: {
            $elements: elements,
            $dead_click_scroll_delay_ms: 120,
            $dead_click_selection_changed_timeout: false,
            $dead_click_event_text: 'secret.gb',
          },
        },
        'web'
      )?.properties
    ).toEqual({
      $elements: [{ tag_name: 'button', nth_child: 2, nth_of_type: 1 }],
      $dead_click_scroll_delay_ms: 120,
      $dead_click_selection_changed_timeout: false,
    });
    expect(
      sanitizeSdkEvent(
        {
          event: '$web_vitals',
          properties: {
            $web_vitals_LCP_value: 1834.2,
            $web_vitals_CLS_value: 0.04,
            $web_vitals_LCP_event: { attribution: { element: 'div#secret' } },
          },
        },
        'web'
      )?.properties
    ).toEqual({ $web_vitals_LCP_value: 1834.2, $web_vitals_CLS_value: 0.04 });
    expect(
      sanitizeSdkEvent(
        {
          event: '$rageclick',
          properties: { $elements: [{ tag_name: 'div', attr__data_ph_no_capture: '' }] },
        },
        'web'
      )
    ).toBeNull();
  });

  it('recognizes PostHog direct visits as direct blog traffic', () => {
    expect(
      sanitizeSdkEvent(
        {
          event: '$pageview',
          properties: {
            $current_url: 'https://www.dnaforge.com/blog/dnaforge-calendar-stack',
            $referrer: '$direct',
          },
        },
        'web'
      )?.properties.blog_source
    ).toBe('direct');
  });

  const poisonedProperties = {
    distinct_id: 'anon-safe-id',
    $session_id: '018f3fd0-0000-7000-8000-000000000000',
    $window_id: '018f3fd0-0000-7000-8000-000000000001',
    $current_url: 'https://dnaforge.com/designs/private-id?token=DNA1598_TOKEN',
    $pathname: '/designs/private-id',
    $el_text: 'DNA1598_SEQUENCE_ATGCGT',
    $elements_chain: 'button.private-secret',
    $referrer: 'https://secret.example/private',
    $elements: [
      {
        tag_name: 'button',
        nth_child: 2,
        nth_of_type: 1,
        text: 'DNA1598_FILENAME_secret.gb',
        attr__data_entry_name: 'DNA1598_FILENAME_secret.gb',
        href: '/private',
      },
    ],
  };

  it('projects autocapture to mechanics, safe URL, and structural elements only', () => {
    expect(
      sanitizeSdkEvent({ event: '$autocapture', properties: poisonedProperties }, 'web')
    ).toEqual({
      event: '$autocapture',
      properties: {
        distinct_id: 'anon-safe-id',
        $session_id: '018f3fd0-0000-7000-8000-000000000000',
        $window_id: '018f3fd0-0000-7000-8000-000000000001',
        $current_url: 'https://dnaforge.com/designs/:id',
        $pathname: '/designs/:id',
        $elements: [{ tag_name: 'button', nth_child: 2, nth_of_type: 1 }],
      },
    });
  });

  it('retains only closed safe-chrome annotation values', () => {
    expect(
      sanitizeSdkEvent(
        {
          event: '$autocapture',
          properties: {
            ...poisonedProperties,
            action: 'navigate',
            surface: 'header',
            private: 'DNA1598_TOKEN',
            $elements: [
              {
                tag_name: 'a',
                attr__data_ph_capture_attribute_action: 'navigate',
                attr__data_ph_capture_attribute_surface: 'header',
                attr__data_ph_capture_attribute_private: 'DNA1598_TOKEN',
              },
            ],
          },
        },
        'web'
      )
    ).toMatchObject({
      properties: {
        action: 'navigate',
        surface: 'header',
        $elements: [{ tag_name: 'a', action: 'navigate', surface: 'header' }],
      },
    });
  });

  it.each([
    { attr__data_ph_no_capture: '' },
    { attr__data_analytics_block: 'true' },
    { classes: ['other', 'ph-no-capture'] },
  ])('drops autocapture when any element is within a blocked root: %o', (blockedMarker) => {
    expect(
      sanitizeSdkEvent(
        {
          event: '$autocapture',
          properties: {
            ...poisonedProperties,
            $elements: [{ tag_name: 'button' }, { tag_name: 'section', ...blockedMarker }],
          },
        },
        'web'
      )
    ).toBeNull();
  });

  it('drops unknown SDK-reserved events', () => {
    expect(
      sanitizeSdkEvent({ event: '$secret_capture', properties: poisonedProperties }, 'web')
    ).toBeNull();
  });

  it.each([null, { event: '$pageview', properties: null }, { event: '$pageview', properties: [] }])(
    'drops invalid capture input: %o',
    (input) => {
      expect(sanitizeSdkEvent(input as never, 'web')).toBeNull();
    }
  );

  it('keeps only registered scalar custom properties', () => {
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    const tooDeep = { a: { b: { c: { d: 'blocked' } } } };
    const tooLargeArray = Array.from({ length: 33 }, (_, index) => index);

    expect(
      sanitizeSdkEvent(
        {
          uuid: '018f3fd0-0000-7000-8000-000000000099',
          event: 'screen_viewed',
          timestamp: new Date('2026-07-21T00:00:00Z'),
          properties: {
            screen_category: 'sequence',
            source_surface: 'tab',
            app_version: '0.3.0',
            file_name: 'DNA1598_FILENAME_secret.gb',
            nested_safe: { safe: [1, true, 'value'] },
            cyclic,
            too_deep: tooDeep,
            too_large: tooLargeArray,
            nullable: null,
            nan: Number.NaN,
          },
        },
        'desktop',
        'sequence',
        {
          screen_viewed: [
            'screen_category',
            'source_surface',
            'nested_safe',
            'cyclic',
            'too_deep',
            'too_large',
            'nullable',
            'nan',
          ],
        }
      )
    ).toEqual({
      uuid: '018f3fd0-0000-7000-8000-000000000099',
      event: 'screen_viewed',
      timestamp: new Date('2026-07-21T00:00:00Z'),
      properties: {
        screen_category: 'sequence',
        source_surface: 'tab',
        app_version: '0.3.0',
      },
    });

    expect(
      sanitizeSdkEvent(
        { event: 'unregistered_event', properties: { feature_area: 'file' } },
        'desktop'
      )
    ).toBeNull();
  });

  it('stamps the generated event version and ignores a producer-supplied version', () => {
    expect(
      sanitizeSdkEvent(
        {
          event: 'screen_viewed',
          properties: { screen_category: 'home', event_version: 999 },
        },
        'desktop',
        'home',
        { screen_viewed: ['screen_category'] },
        undefined,
        { screen_viewed: 3 }
      )
    ).toEqual({
      event: 'screen_viewed',
      properties: { screen_category: 'home', event_version: 3 },
    });
  });

  it('preserves only the configured public PostHog project token added by the SDK', () => {
    const policy = { screen_viewed: ['screen_category'] };
    const projectToken = 'phc_0123456789abcdef';
    expect(
      sanitizeSdkEvent(
        {
          event: 'screen_viewed',
          properties: {
            token: 'phc_0123456789abcdef',
            screen_category: 'home',
          },
        },
        'desktop',
        'home',
        policy,
        projectToken
      )
    ).toEqual({
      event: 'screen_viewed',
      properties: { token: 'phc_0123456789abcdef', screen_category: 'home' },
    });

    expect(
      sanitizeSdkEvent(
        {
          event: 'screen_viewed',
          properties: { token: 'secret-server-token', screen_category: 'home' },
        },
        'desktop',
        'home',
        policy,
        projectToken
      )
    ).toEqual({ event: 'screen_viewed', properties: { screen_category: 'home' } });

    expect(
      sanitizeSdkEvent(
        {
          event: 'screen_viewed',
          properties: { token: 'phc_abcdef0123456789', screen_category: 'home' },
        },
        'desktop',
        'home',
        policy,
        projectToken
      )
    ).toEqual({ event: 'screen_viewed', properties: { screen_category: 'home' } });
  });

  it('keeps the bounded join, actor, and synthetic-canary dimensions on semantic events', () => {
    const installId = '018f3fd0-0000-7000-8000-000000000031';
    const canaryId = '018f3fd0-0000-7000-8000-000000000032';
    const downloadId = '018f3fd0-0000-4000-8000-000000000033';
    expect(
      sanitizeSdkEvent(
        {
          event: 'screen_viewed',
          properties: {
            screen_category: 'home',
            pseudonymous_install_id: installId,
            pseudonymous_download_id: downloadId,
            is_synthetic: true,
            telemetry_canary_id: canaryId,
            telemetry_actor: 'canary',
            ci_run_id: '32902696778',
            build_tag: 'v0.8.0-beta.1',
          },
        },
        'desktop',
        'home',
        { screen_viewed: ['screen_category'] }
      )
    ).toEqual({
      event: 'screen_viewed',
      properties: {
        screen_category: 'home',
        pseudonymous_install_id: installId,
        pseudonymous_download_id: downloadId,
        is_synthetic: true,
        telemetry_canary_id: canaryId,
        telemetry_actor: 'canary',
        build_tag: 'v0.8.0-beta.1',
      },
    });

    expect(
      sanitizeSdkEvent(
        {
          event: 'screen_viewed',
          properties: {
            screen_category: 'home',
            telemetry_actor: 'ci',
            ci_run_id: '32902696778',
          },
        },
        'desktop',
        'home',
        { screen_viewed: ['screen_category'] }
      )
    ).toEqual({
      event: 'screen_viewed',
      properties: {
        screen_category: 'home',
        telemetry_actor: 'ci',
        ci_run_id: '32902696778',
      },
    });
  });

  it('handles empty, invalid, and bounded autocapture element metadata', () => {
    expect(
      sanitizeSdkEvent(
        {
          event: '$autocapture',
          properties: {
            distinct_id: 'anon_00000001',
            $elements: [
              null,
              { tag_name: 42 },
              {
                tag_name: 'BUTTON',
                nth_child: -1,
                nth_of_type: 10_001,
                attr__data_ph_capture_attribute_action: 42,
                attr__data_ph_capture_attribute_surface: 'private_surface',
              },
            ],
          },
        },
        'web'
      )
    ).toEqual({
      event: '$autocapture',
      properties: {
        distinct_id: 'anon_00000001',
        $elements: [{ tag_name: 'button' }],
      },
    });

    expect(
      sanitizeSdkEvent(
        { event: '$autocapture', properties: { distinct_id: 'anon_00000001' } },
        'web'
      )
    ).toEqual({ event: '$autocapture', properties: { distinct_id: 'anon_00000001' } });
  });

  it('normalizes desktop replay Meta URLs and drops opaque compressed frames', () => {
    const compressed = { type: 2, cv: '2024-10', data: 'opaque-compressed-frame' };
    const dom = { type: 2, data: { node: { type: 0 } } };
    const meta = {
      type: 4,
      timestamp: 123,
      data: {
        href: 'file:///private/local-source/out/index.html?e2e=true',
        width: 1280,
        height: 720,
      },
    };
    const sent = sanitizeSdkEvent(
      { event: '$snapshot', properties: { $snapshot_data: [meta, compressed, dom] } },
      'desktop',
      'settings'
    );
    expect(sent?.properties.$snapshot_data).toEqual([
      { ...meta, data: { ...meta.data, href: 'dnaforge://desktop/settings' } },
      dom,
    ]);
    expect(
      sanitizeSdkEvent(
        { event: '$snapshot', properties: { $snapshot_data: [compressed] } },
        'desktop',
        'settings'
      )
    ).toBeNull();
    expect(meta.data.href).toContain('/private/local-source/');
  });

  it('keeps session replay snapshots and drops poisoned person properties on them', () => {
    const snapshot = { type: 2, data: { node: { type: 0 } } };
    const sanitized = sanitizeSdkEvent(
      {
        event: '$snapshot',
        properties: { ...poisonedProperties, $snapshot_data: snapshot, $snapshot_bytes: 128 },
      },
      'desktop',
      'sequence'
    );
    expect(sanitized?.event).toBe('$snapshot');
    expect(sanitized?.properties.$snapshot_data).toEqual(snapshot);
    expect(sanitized?.properties.$snapshot_bytes).toBe(128);
    expect(sanitized?.properties.distinct_id).toBe('anon-safe-id');
    expect(sanitized?.properties).not.toHaveProperty('$el_text');
    expect(sanitized?.properties).not.toHaveProperty('$referrer');
  });

  it('keeps snapshot mechanics and pageview mechanics', () => {
    expect(
      sanitizeSdkEvent(
        {
          event: '$snapshot',
          properties: { distinct_id: 'anon_00000001', $snapshot_bytes: 128 },
        },
        'web'
      )
    ).toEqual({
      event: '$snapshot',
      properties: { distinct_id: 'anon_00000001', $snapshot_bytes: 128 },
    });
    expect(
      sanitizeSdkEvent({ event: '$pageview', properties: { distinct_id: 'anon_00000001' } }, 'web')
    ).toEqual({ event: '$pageview', properties: { distinct_id: 'anon_00000001' } });
  });

  it('strips identify person properties and rejects a non-UUID account identity', () => {
    expect(
      sanitizeSdkEvent(
        {
          event: '$identify',
          properties: {
            distinct_id: 'person@example.com',
            $anon_distinct_id: '018f3fd0-0000-7000-8000-000000000000',
          },
          $set: { email: 'person@example.com' },
          $set_once: { name: 'DNA1598_NAME' },
        },
        'web'
      )
    ).toBeNull();
  });

  it('keeps only a UUID organization group on SDK events', () => {
    const org = '018f3fd0-0000-7000-8000-000000000031';
    const sanitize = ($groups: unknown) =>
      sanitizeSdkEvent(
        { event: '$pageview', properties: { $groups, $session_id: 'session-a' } },
        'web'
      )?.properties.$groups;
    expect(sanitize({ organization: org })).toEqual({ organization: org });
    expect(sanitize({ organization: 'Lab of Dr Example' })).toBeUndefined();
    expect(sanitize({ organization: org, project: org })).toBeUndefined();
    expect(sanitize('organization')).toBeUndefined();
  });

  it('admits organization group identify events without group properties', () => {
    const org = '018f3fd0-0000-7000-8000-000000000031';
    expect(
      sanitizeSdkEvent(
        {
          event: '$groupidentify',
          properties: {
            $group_type: 'organization',
            $group_key: org,
            $group_set: { name: 'Example Lab', members: ['a@example.com'] },
          },
        },
        'web'
      )
    ).toEqual({
      event: '$groupidentify',
      properties: { $group_type: 'organization', $group_key: org, $group_set: {} },
    });
    expect(
      sanitizeSdkEvent(
        { event: '$groupidentify', properties: { $group_type: 'company', $group_key: org } },
        'web'
      )
    ).toBeNull();
    expect(
      sanitizeSdkEvent(
        {
          event: '$groupidentify',
          properties: { $group_type: 'organization', $group_key: 'example-lab' },
        },
        'web'
      )
    ).toBeNull();
  });

  it('keeps identify UUIDs and a bounded person $set', () => {
    expect(
      sanitizeSdkEvent(
        {
          event: '$identify',
          properties: {
            distinct_id: '018f3fd0-0000-7000-8000-000000000021',
            $anon_distinct_id: '018f3fd0-0000-7000-8000-000000000020',
          },
          $set: {
            email: 'DNA1598_EMAIL@example.com',
            name: 'Peter',
            internal_operator: 'operator_a',
            extra: 'drop-me',
          },
        },
        'web'
      )
    ).toEqual({
      event: '$identify',
      properties: {
        distinct_id: '018f3fd0-0000-7000-8000-000000000021',
        $anon_distinct_id: '018f3fd0-0000-7000-8000-000000000020',
      },
      $set: {
        email: 'dna1598_email@example.com',
        name: 'Peter',
        internal_operator: 'operator_a',
      },
    });

    expect(
      sanitizeSdkEvent(
        {
          event: '$identify',
          properties: {
            distinct_id: '018f3fd0-0000-7000-8000-000000000021',
            $anon_distinct_id: 'not-an-uuid',
          },
        },
        'web'
      )
    ).toBeNull();
  });
});

describe('main-process identity generation fence', () => {
  const context = (
    generation: number,
    distinctId: string,
    kind: AnalyticsIdentityContext['kind'] = 'anonymous'
  ): AnalyticsIdentityContext => ({
    generation,
    kind,
    distinctId,
    sessionId: `018f3fd0-0000-7000-8000-${String(generation).padStart(12, '0')}`,
  });

  it('accepts the first and later generations but rejects stale or equal updates', () => {
    const a = context(1, 'anon_00000001');
    const user = context(2, '018f3fd0-0000-7000-8000-000000000021', 'identified');
    const signedOut = context(3, 'anon_00000002');

    expect(acceptIdentityContext(null, a)).toEqual(a);
    expect(acceptIdentityContext(a, user)).toEqual(user);
    expect(acceptIdentityContext(user, signedOut)).toEqual(signedOut);
    expect(acceptIdentityContext(signedOut, user)).toBeNull();
    expect(acceptIdentityContext(signedOut, signedOut)).toBeNull();
  });

  it('accepts generation one from a new renderer document after reload', () => {
    const oldRenderer = {
      ...context(8, 'anon_00000001'),
      rendererInstanceId: '018f3fd0-0000-7000-8000-000000000101',
    };
    const reloadedRenderer = {
      ...context(1, 'anon_00000002'),
      rendererInstanceId: '018f3fd0-0000-7000-8000-000000000102',
    };

    expect(acceptIdentityContext(oldRenderer, reloadedRenderer)).toEqual(reloadedRenderer);
    expect(
      acceptIdentityContext(reloadedRenderer, { ...reloadedRenderer, generation: 1 })
    ).toBeNull();
  });

  it('rejects malformed or cross-kind identity contexts', () => {
    expect(acceptIdentityContext(null, context(-1, 'anon_00000001'))).toBeNull();
    expect(acceptIdentityContext(null, context(1, '', 'anonymous'))).toBeNull();
    expect(acceptIdentityContext(null, context(1, 'person@example.com', 'identified'))).toBeNull();
    expect(
      acceptIdentityContext(null, {
        ...context(1, 'anon_00000001'),
        sessionId: 'DNA1598_FILENAME_secret.gb',
      })
    ).toBeNull();
    expect(
      acceptIdentityContext(null, {
        ...context(1, 'anon_00000001'),
        kind: 'invalid' as never,
      })
    ).toBeNull();
    expect(acceptIdentityContext(null, context(1, 'fallback_00000001', 'fallback'))).toEqual(
      context(1, 'fallback_00000001', 'fallback')
    );
  });
});

describe('private exception SDK events', () => {
  it('retains exception type and owned code coordinates without customer text or local paths', () => {
    const event = sanitizeSdkEvent(
      {
        event: '$exception',
        properties: {
          $exception_level: 'error',
          $exception_list: [
            {
              type: 'TypeError',
              value: 'PATIENT alice@example.invalid ACGTACGTACGTACGTACGT',
              mechanism: { type: 'generic', handled: false, synthetic: false },
              stacktrace: {
                type: 'raw',
                frames: [
                  {
                    filename:
                      '/Users/alice/DNAForge.app/Contents/Resources/app.asar/out/main/index.js',
                    function: 'PATIENT_PRIVATE',
                    lineno: 12,
                    colno: 34,
                    in_app: true,
                    platform: 'node:javascript',
                    pre_context: ['PATIENT_PRIVATE'],
                    vars: { secret: 'PATIENT_PRIVATE' },
                  },
                ],
              },
            },
          ],
          $exception_message: 'PATIENT_PRIVATE',
          $exception_stack_trace_raw: '/Users/alice/private.gb',
        },
      },
      'desktop'
    );
    expect(event?.properties.$exception_list).toEqual([
      {
        type: 'TypeError',
        value: 'Application exception',
        mechanism: { type: 'generic', handled: false, synthetic: false },
        stacktrace: {
          type: 'raw',
          frames: [
            {
              filename: 'app:///out/main/index.js',
              lineno: 12,
              colno: 34,
              in_app: true,
              platform: 'node:javascript',
            },
          ],
        },
      },
    ]);
    expect(event?.properties.$exception_level).toBe('error');
    expect(JSON.stringify(event)).not.toMatch(/PATIENT|alice|ACGT|private\.gb/);
  });
  it('keeps web chunk identifiers for symbolication while excluding user code frames and invalid metadata', () => {
    const event = sanitizeSdkEvent(
      {
        event: '$exception',
        properties: {
          $exception_list: [
            {
              type: 'CUSTOM_PATIENT_ERROR',
              value: 'private',
              stacktrace: {
                frames: [
                  {
                    filename:
                      'https://www.dnaforge.com/_next/static/chunks/app/page-build.js?secret=PATIENT',
                    lineno: 7,
                    colno: 9,
                    chunk_id: '550e8400-e29b-41d4-a716-446655440000',
                    function: 'PATIENT',
                  },
                  { filename: 'https://customer.invalid/PATIENT.js', lineno: 5, colno: 6 },
                  { filename: '/Users/alice/private.js', lineno: 1 },
                ],
              },
            },
          ],
        },
      },
      'web'
    );
    expect(event?.properties.$exception_list).toEqual([
      {
        type: 'Error',
        value: 'Application exception',
        mechanism: { type: 'generic', handled: false, synthetic: false },
        stacktrace: {
          type: 'raw',
          frames: [
            {
              filename: 'https://www.dnaforge.com/_next/static/chunks/app/page-build.js',
              lineno: 7,
              colno: 9,
              in_app: true,
              platform: 'web:javascript',
              chunk_id: '550e8400-e29b-41d4-a716-446655440000',
            },
          ],
        },
      },
    ]);
    expect(JSON.stringify(event)).not.toMatch(/PATIENT|alice|customer|secret/);
    for (const list of [undefined, [], 'private', [{ type: 'Error' }]])
      expect(
        sanitizeSdkEvent({ event: '$exception', properties: { $exception_list: list } }, 'web')
      ).toBeNull();
  });
});
