import { sha256 } from '@noble/hashes/sha2';
import { bytesToHex, utf8ToBytes } from '@noble/hashes/utils';
import type { AnalyticsConsentRegime } from './consent-regime';
import { sanitizeDesktopReplayData } from './desktop-replay';

export {
  localeCountryCode,
  resolveAnalyticsConsentRegime,
  type AnalyticsConsentRegime,
  type AnalyticsRegionSignals,
} from './consent-regime';
export {
  DESKTOP_REPLAY_BLOCK_ATTRIBUTE,
  DESKTOP_SESSION_RECORDING_CONFIG,
  sanitizeDesktopReplayData,
} from './desktop-replay';

export type AnalyticsSurface = 'desktop' | 'web';

export type AnalyticsConsentBasis = 'explicit' | 'default';

export interface ConsentPolicyInput {
  surface: AnalyticsSurface;
  storedConsent: string | null | undefined;
  storedVersion: string | null | undefined;
  storedBasis?: string | null;
  regime?: AnalyticsConsentRegime;
}

export interface ConsentPolicyDecision {
  enabled: boolean;
  needsDisclosure: boolean;
  consent: 'true' | 'false' | null;
  version: '3' | null;
}

export interface AnalyticsIdentityContext {
  generation: number;
  kind: 'anonymous' | 'identified' | 'fallback';
  distinctId: string;
  sessionId: string;
  rendererInstanceId?: string;
}

export interface SdkCaptureEvent {
  uuid?: string;
  event: string;
  properties: Record<string, unknown>;
  $set?: Record<string, unknown>;
  $set_once?: Record<string, unknown>;
  timestamp?: Date;
}

export type CustomEventPropertyPolicy = Readonly<Record<string, readonly string[]>>;
export type CustomEventVersionPolicy = Readonly<Record<string, number>>;

export const ANALYTICS_CONSENT_VERSION = '3' as const;

export const TELEMETRY_ACTORS = ['user', 'maintainer', 'ci', 'canary', 'dev'] as const;
export type TelemetryActor = (typeof TELEMETRY_ACTORS)[number];

export const INTERNAL_OPERATORS = ['operator_a', 'operator_b'] as const;
export type InternalOperator = (typeof INTERNAL_OPERATORS)[number];

const INTERNAL_OPERATOR_SET = new Set<string>(INTERNAL_OPERATORS);
export const INTERNAL_OPERATOR_EMAIL_DIGESTS: ReadonlyMap<string, InternalOperator> = new Map([]);

export function internalOperatorEmailDigest(normalizedEmail: string): string {
  return bytesToHex(sha256(utf8ToBytes(normalizedEmail)));
}

export function classifyInternalOperatorWithDigests(
  value: unknown,
  emailDigests: ReadonlyMap<string, InternalOperator>
): InternalOperator | undefined {
  if (typeof value !== 'string') return undefined;
  const normalized = value.trim().toLowerCase();
  if (INTERNAL_OPERATOR_SET.has(normalized)) return normalized as InternalOperator;
  if (!normalized.includes('@')) return undefined;
  return emailDigests.get(internalOperatorEmailDigest(normalized));
}

export function classifyInternalOperator(value: unknown): InternalOperator | undefined {
  return classifyInternalOperatorWithDigests(value, INTERNAL_OPERATOR_EMAIL_DIGESTS);
}

export const AUTH_PROVIDER_CATEGORIES = [
  'google',
  'github',
  'magic_link',
  'workos',
  'unknown',
] as const;
export type AuthProviderCategory = (typeof AUTH_PROVIDER_CATEGORIES)[number];

const TELEMETRY_ACTOR_SET = new Set<string>(TELEMETRY_ACTORS);
const SAFE_CI_RUN_ID_RE = /^[1-9][0-9]{0,19}$/;

export function normalizeTelemetryActor(value: unknown): TelemetryActor | undefined {
  if (typeof value !== 'string') return undefined;
  const normalized = value.trim().toLowerCase();
  return TELEMETRY_ACTOR_SET.has(normalized) ? (normalized as TelemetryActor) : undefined;
}

export function sanitizeCiRunId(value: unknown): string | undefined {
  return typeof value === 'string' && SAFE_CI_RUN_ID_RE.test(value) ? value : undefined;
}

export function resolveWebTelemetryActor(input: {
  environment: unknown;
  releaseChannel: unknown;
  explicitActor?: unknown;
}): TelemetryActor {
  const explicitActor = normalizeTelemetryActor(input.explicitActor);
  if (explicitActor && explicitActor !== 'user') return explicitActor;

  const environment =
    typeof input.environment === 'string' ? input.environment.trim().toLowerCase() : 'unknown';
  const releaseChannel =
    typeof input.releaseChannel === 'string'
      ? input.releaseChannel.trim().toLowerCase()
      : 'unknown';
  if (environment !== 'production' || releaseChannel === 'dev' || releaseChannel === 'preview') {
    return 'dev';
  }
  return 'user';
}

export const DESKTOP_ANALYTICS_TOAST_MESSAGE =
  'DNAForge shares usage analytics and crash reports to help improve the app. You can turn this off in Settings.';

export const DESKTOP_ANALYTICS_OPT_IN_MESSAGE =
  'Share usage analytics and crash reports to help improve DNAForge? Nothing is shared unless you allow it. You can change this in Settings.';

export const DESKTOP_ANALYTICS_DISCLOSURE =
  'Usage analytics go to PostHog: workflow events, clicks, key presses (never which key), pointer gestures, session replay with all text, typing and open documents hidden, feature flags, a pseudonymous install ID, and a labeled account identity when you sign in. Crash reports and startup checks go to Sentry and DNAForge with the install ID and logs scrubbed of emails, keys, file paths, sequences and quoted text. Turning this off stops both and deletes unsent telemetry on this device, but does not erase copies already received; use the Privacy Policy contact to request deletion.';

export const WEB_ANALYTICS_DISCLOSURE =
  'This website uses optional analytics cookies to understand how visitors use the site. You can change this anytime.';

export const SAFE_AUTOCAPTURE_CONFIG = {
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
} as const;

export const SESSION_RECORDING_CONFIG = {
  blockSelector: '[data-analytics-block], [data-ph-no-capture], .ph-no-capture',
  maskAllInputs: false,
  maskInputOptions: { password: true },
  maskTextSelector: 'input[type="password"], [data-ph-mask]',
  recordCrossOriginIframes: false,
  collectFonts: false,
} as const;

export const CLICK_FIREHOSE_FLAG = 'telemetry-click-firehose';

export const SAFE_POSTHOG_PRIVACY_CONFIG = {
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
} as const;

export const SAFE_SCREEN_CATEGORIES = [
  'home',
  'files',
  'sequence',
  'design',
  'assembly',
  'primers',
  'protein',
  'alignment',
  'structure',
  'page',
  'document',
  'chat',
  'search',
  'settings',
  'account',
  'jobs',
  'source_control',
  'lims',
  'references',
  'toolbox',
  'unknown',
] as const;
export type SafeScreenCategory = (typeof SAFE_SCREEN_CATEGORIES)[number];

export const SAFE_SOURCE_SURFACES = [
  'file_tree',
  'search',
  'mention',
  'recent',
  'startup',
  'tab',
  'sidebar',
  'menu',
  'unknown',
] as const;
export type SafeSourceSurface = (typeof SAFE_SOURCE_SURFACES)[number];

export const SAFE_WORKSPACE_SOURCES = [
  'startup_arg',
  'automatic_sample',
  'sample_selection',
  'recent',
  'folder_picker',
  'sync',
  'cli',
  'e2e',
  'unknown',
] as const;
export type SafeWorkspaceSource = (typeof SAFE_WORKSPACE_SOURCES)[number];

export const SAFE_WORKSPACE_KINDS = ['git', 'folder', 'managed', 'unknown'] as const;
export type SafeWorkspaceKind = (typeof SAFE_WORKSPACE_KINDS)[number];
export const SAFE_FILE_COUNT_BUCKETS = ['0', '1', '2_5', '6_20', '21_100', '100_plus'] as const;
export type SafeFileCountBucket = (typeof SAFE_FILE_COUNT_BUCKETS)[number];
export const SAFE_FILE_TYPE_CATEGORIES = [
  'dna',
  'protein',
  'sequence',
  'spreadsheet',
  'image',
  'text',
  'unknown',
] as const;
export type SafeFileTypeCategory = (typeof SAFE_FILE_TYPE_CATEGORIES)[number];
export const SAFE_FILE_SIZE_BUCKETS = [
  '0',
  '1_10kb',
  '10_100kb',
  '100kb_1mb',
  '1_10mb',
  '10mb_plus',
  'unknown',
] as const;
export type SafeFileSizeBucket = (typeof SAFE_FILE_SIZE_BUCKETS)[number];
export const SAFE_OPERATION_ERROR_CLASSES = [
  'cancelled',
  'validation',
  'compute',
  'sidecar',
  'timeout',
  'filesystem',
  'projection',
  'not_ready',
  'parse_failed',
  'write_failed',
  'sidecar_unreachable',
  'unknown',
] as const;
export type SafeOperationErrorClass = (typeof SAFE_OPERATION_ERROR_CLASSES)[number];

const SAFE_SCREEN_CATEGORY_SET = new Set<string>(SAFE_SCREEN_CATEGORIES);
export const SAFE_AUTOCAPTURE_ACTIONS = [
  'navigate',
  'open',
  'close',
  'submit',
  'accept',
  'reject',
  'enable',
  'disable',
  'unknown',
] as const;
export type SafeAutocaptureAction = (typeof SAFE_AUTOCAPTURE_ACTIONS)[number];
const SAFE_AUTOCAPTURE_ACTION_SET = new Set<string>(SAFE_AUTOCAPTURE_ACTIONS);
export const SAFE_AUTOCAPTURE_SURFACES = [
  'header',
  'footer',
  'cookie_banner',
  'privacy_preferences',
  'static_page',
  'auth',
  'unknown',
] as const;
export type SafeAutocaptureSurface = (typeof SAFE_AUTOCAPTURE_SURFACES)[number];
const SAFE_AUTOCAPTURE_SURFACE_SET = new Set<string>(SAFE_AUTOCAPTURE_SURFACES);
const SAFE_UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SAFE_OPAQUE_ID_RE = /^[a-zA-Z0-9_-]{8,256}$/;
const WEB_STATIC_ROUTES = new Set([
  '/',
  '/about',
  '/account',
  '/account/orgs',
  '/account/shares',
  '/account/sync-history',
  '/blog',
  '/compare',
  '/desktop-auth',
  '/docs',
  '/download',
  '/hackathon',
  '/login',
  '/onboarding',
  '/org/new',
  '/privacy',
  '/register',
  '/settings',
  '/start',
  '/terms',
]);
const WEB_ROUTE_PATTERNS: readonly (readonly [RegExp, string])[] = [
  [/^\/beta\/install\/[^/]+$/, '/beta/install/:token'],
  [/^\/invite\/[^/]+$/, '/invite/:token'],
  [/^\/project-invite\/[^/]+$/, '/project-invite/:token'],
  [/^\/d\/[^/]+$/, '/d/:id'],
  [/^\/account\/projects\/[^/]+\/access$/, '/account/projects/:id/access'],
  [/^\/org\/[^/]+$/, '/org/:slug'],
  [
    /^\/org\/[^/]+\/(audit|invites|members|projects|registry|settings|sync-health)$/,
    '/org/:slug/$1',
  ],
];
const PUBLIC_DOCS_PATH_RE = /^\/docs(?:\/[a-z0-9][a-z0-9-]{0,80}){1,4}$/;
const ATTRIBUTION_VALUE_RE = /^[a-z0-9][a-z0-9._-]{0,63}$/;
const HOSTNAME_RE =
  /^(?=.{1,253}$)[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/;
const UTM_KEYS = ['utm_source', 'utm_medium', 'utm_campaign', 'utm_content', 'utm_term'] as const;
const FEATURE_FLAG_KEY_RE = /^[A-Za-z0-9_.-]{1,128}$/;

export const PUBLIC_BLOG_POST_PATHS = [
  '/blog/best-ai-biology-platform',
  '/blog/dnaforge-calendar-stack',
  '/blog/dnaforge-molecular-biology-design-software',
] as const;
const PUBLIC_BLOG_POST_PATH_SET = new Set<string>(PUBLIC_BLOG_POST_PATHS);

const BLOG_UTM_SOURCES = new Set([
  'google',
  'bing',
  'duckduckgo',
  'linkedin',
  'x',
  'twitter',
  'reddit',
  'facebook',
  'instagram',
  'youtube',
  'github',
  'hackernews',
  'chatgpt',
  'perplexity',
  'claude',
  'newsletter',
  'email',
  'substack',
]);
const BLOG_UTM_MEDIUMS = new Set([
  'organic',
  'social',
  'email',
  'newsletter',
  'referral',
  'cpc',
  'paid',
]);
const BLOG_REFERRER_SOURCES: Readonly<Record<string, string>> = {
  'google.com': 'google',
  'bing.com': 'bing',
  'duckduckgo.com': 'duckduckgo',
  'linkedin.com': 'linkedin',
  'x.com': 'x',
  't.co': 'x',
  'twitter.com': 'twitter',
  'reddit.com': 'reddit',
  'facebook.com': 'facebook',
  'instagram.com': 'instagram',
  'youtube.com': 'youtube',
  'github.com': 'github',
  'news.ycombinator.com': 'hackernews',
  'chatgpt.com': 'chatgpt',
  'perplexity.ai': 'perplexity',
  'claude.ai': 'claude',
  'substack.com': 'substack',
  'dnaforge.com': 'internal',
};

const COMMON_MECHANIC_KEYS = new Set([
  'token',
  'distinct_id',
  '$device_id',
  '$session_id',
  '$window_id',
  '$lib',
  '$lib_version',
  '$geoip_disable',
  '$process_person_profile',
  '$time',
  '$insert_id',
  '$browser',
  '$browser_version',
  '$os',
  '$os_version',
  '$device_type',
  '$screen_height',
  '$screen_width',
  '$viewport_height',
  '$viewport_width',
  '$host',
  '$event_type',
  '$element_type',
]);

export const ANALYTICS_ORGANIZATION_GROUP = 'organization';

const ALLOWED_SDK_EVENTS = new Set([
  '$exception',
  '$autocapture',
  '$groupidentify',
  '$rageclick',
  '$dead_click',
  '$web_vitals',
  '$pageview',
  '$pageleave',
  '$identify',
  '$opt_in',
  '$set',
  '$feature_flag_called',
  '$snapshot',
  '$snapshot_item',
]);
const ELEMENT_GESTURE_EVENTS = new Set(['$autocapture', '$rageclick', '$dead_click']);
const DEAD_CLICK_NUMBER_KEY_RE = /^\$dead_click_[a-z_]{1,64}$/;
const WEB_VITALS_VALUE_KEY_RE = /^\$web_vitals_(LCP|CLS|FCP|INP|TTFB)_value$/;

const PERSON_SET_EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function sanitizePersonSet(value: unknown): Record<string, string> | undefined {
  if (!isRecord(value)) return undefined;
  const next: Record<string, string> = {};
  if (
    typeof value.email === 'string' &&
    value.email.length <= 320 &&
    PERSON_SET_EMAIL_RE.test(value.email)
  ) {
    next.email = value.email.trim().toLowerCase();
  }
  if (typeof value.name === 'string') {
    const name = value.name.replace(/\s+/g, ' ').trim().slice(0, 80);
    if (name.length > 0) next.name = name;
  }
  if (value.internal_operator === 'operator_a' || value.internal_operator === 'operator_b') {
    next.internal_operator = value.internal_operator;
  }
  return Object.keys(next).length > 0 ? next : undefined;
}

const COMMON_CUSTOM_PROPERTY_KEYS = new Set([
  'app_version',
  'platform_family',
  'environment',
  'release_channel',
  'build_tag',
  'artifact_build_tag',
  'telemetry_mode',
  'beta_invite_id',
  'beta_cohort',
  'invite_batch',
  'app_session_id',
  'episode_correlation_id',
  'pseudonymous_install_id',
  'pseudonymous_attempt_id',
  'pseudonymous_download_id',
  'is_synthetic',
  'telemetry_canary_id',
  'telemetry_actor',
  'ci_run_id',
  'internal_operator',
  'identity_kind',
]);

export function resolveConsentPolicy(input: ConsentPolicyInput): ConsentPolicyDecision {
  const consent = input.storedConsent;
  const isCurrent = input.storedVersion === ANALYTICS_CONSENT_VERSION;

  if (consent === 'false') {
    return {
      enabled: false,
      needsDisclosure: false,
      consent: 'false',
      version: ANALYTICS_CONSENT_VERSION,
    };
  }

  const granted =
    consent === 'true' &&
    isCurrent &&
    (input.surface === 'web' || input.regime === 'opt_out' || input.storedBasis === 'explicit');
  if (granted) {
    return {
      enabled: true,
      needsDisclosure: false,
      consent: 'true',
      version: ANALYTICS_CONSENT_VERSION,
    };
  }

  if (input.surface === 'desktop' && input.regime === 'opt_out') {
    return {
      enabled: true,
      needsDisclosure: true,
      consent: 'true',
      version: ANALYTICS_CONSENT_VERSION,
    };
  }

  return {
    enabled: false,
    needsDisclosure: true,
    consent: null,
    version: null,
  };
}

export function sanitizeAnalyticsUrl(
  rawUrl: unknown,
  surface: AnalyticsSurface,
  screenCategory = 'unknown'
): string {
  if (surface === 'desktop') {
    const safeScreen = SAFE_SCREEN_CATEGORY_SET.has(screenCategory) ? screenCategory : 'unknown';
    return `dnaforge://desktop/${safeScreen}`;
  }

  if (typeof rawUrl !== 'string') return 'https://dnaforge.invalid/other';

  try {
    const parsed = new URL(rawUrl);
    if (!['http:', 'https:'].includes(parsed.protocol)) {
      return 'https://dnaforge.invalid/other';
    }
    return `${parsed.origin}${categorizeWebPath(parsed.pathname)}`;
  } catch {
    return 'https://dnaforge.invalid/other';
  }
}

export function sanitizeSdkEvent(
  input: SdkCaptureEvent | null,
  surface: AnalyticsSurface,
  screenCategory = 'unknown',
  customPropertyPolicy: CustomEventPropertyPolicy = {},
  allowedProjectToken?: string,
  customEventVersionPolicy: CustomEventVersionPolicy = {}
): SdkCaptureEvent | null {
  if (!input || typeof input.event !== 'string' || !isRecord(input.properties)) return null;

  if (input.event.startsWith('$') && !ALLOWED_SDK_EVENTS.has(input.event)) return null;

  const customKeys = !input.event.startsWith('$') ? customPropertyPolicy[input.event] : undefined;
  if (!input.event.startsWith('$') && !customKeys) return null;

  if (
    ELEMENT_GESTURE_EVENTS.has(input.event) &&
    Array.isArray(input.properties.$elements) &&
    input.properties.$elements.some(isBlockedElement)
  ) {
    return null;
  }

  if (
    input.event === '$identify' &&
    (!isUuid(input.properties.distinct_id) || !isUuid(input.properties.$anon_distinct_id))
  ) {
    return null;
  }

  if (
    input.event === '$groupidentify' &&
    (input.properties.$group_type !== ANALYTICS_ORGANIZATION_GROUP ||
      !isUuid(input.properties.$group_key))
  ) {
    return null;
  }

  const properties: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(input.properties)) {
    if (key === 'token') {
      if (
        typeof value === 'string' &&
        value === allowedProjectToken &&
        /^phc_[a-zA-Z0-9_-]{8,256}$/.test(value)
      ) {
        properties[key] = value;
      }
    } else if (COMMON_MECHANIC_KEYS.has(key) && isScalar(value)) {
      properties[key] = value;
    }
  }

  const groups = organizationGroups(input.properties.$groups);
  if (groups) properties.$groups = groups;
  if (input.event === '$groupidentify') {
    properties.$group_type = ANALYTICS_ORGANIZATION_GROUP;
    properties.$group_key = input.properties.$group_key;
    properties.$group_set = {};
  }

  const rawCurrentUrl = input.properties.$current_url;
  if (rawCurrentUrl !== undefined) {
    const safeUrl = sanitizeAnalyticsUrl(rawCurrentUrl, surface, screenCategory);
    properties.$current_url = safeUrl;
    properties.$pathname = safePathname(safeUrl, surface);
  }

  if (
    surface === 'web' &&
    input.event === '$pageview' &&
    (properties.$pathname === '/blog' ||
      PUBLIC_BLOG_POST_PATH_SET.has(properties.$pathname as string))
  ) {
    const utmSource = boundedBlogValue(input.properties.utm_source, BLOG_UTM_SOURCES);
    const utmMedium = boundedBlogValue(input.properties.utm_medium, BLOG_UTM_MEDIUMS);
    if (utmSource) properties.blog_utm_source = utmSource;
    if (utmMedium) properties.blog_utm_medium = utmMedium;
    properties.blog_source = utmSource ?? blogReferrerSource(input.properties.$referrer);
  }

  if (surface === 'web' && (input.event === '$pageview' || input.event === '$pageleave')) {
    Object.assign(properties, acquisitionProperties(input.properties));
  }

  if (input.event === '$feature_flag_called') {
    const flag = input.properties.$feature_flag;
    const response = input.properties.$feature_flag_response;
    if (typeof flag === 'string' && FEATURE_FLAG_KEY_RE.test(flag)) properties.$feature_flag = flag;
    if (typeof response === 'boolean') properties.$feature_flag_response = response;
    else if (typeof response === 'string' && FEATURE_FLAG_KEY_RE.test(response)) {
      properties.$feature_flag_response = response;
    }
  }

  if (input.event === '$dead_click') {
    for (const [key, value] of Object.entries(input.properties)) {
      if (
        DEAD_CLICK_NUMBER_KEY_RE.test(key) &&
        (isFiniteNumber(value) || typeof value === 'boolean')
      ) {
        properties[key] = value;
      }
    }
  }

  if (input.event === '$web_vitals') {
    for (const [key, value] of Object.entries(input.properties)) {
      if (WEB_VITALS_VALUE_KEY_RE.test(key) && isFiniteNumber(value)) properties[key] = value;
    }
  }

  if (ELEMENT_GESTURE_EVENTS.has(input.event)) {
    const elements = sanitizeElements(input.properties.$elements);
    if (elements.length > 0) properties.$elements = elements;
    const action = enumValue(input.properties.action, SAFE_AUTOCAPTURE_ACTION_SET);
    const surface = enumValue(input.properties.surface, SAFE_AUTOCAPTURE_SURFACE_SET);
    if (action) properties.action = action;
    if (surface) properties.surface = surface;
  } else if (input.event === '$identify') {
    properties.$anon_distinct_id = input.properties.$anon_distinct_id;
  } else if (input.event === '$snapshot' || input.event === '$snapshot_item') {
    if ('$snapshot_data' in input.properties) {
      if (surface === 'desktop') {
        const data = sanitizeDesktopReplayData(
          input.properties.$snapshot_data,
          sanitizeAnalyticsUrl(undefined, 'desktop', screenCategory)
        );
        if (data === null) return null;
        properties.$snapshot_data = data;
      } else {
        properties.$snapshot_data = input.properties.$snapshot_data;
      }
    }
    if (typeof input.properties.$snapshot_bytes === 'number') {
      properties.$snapshot_bytes = input.properties.$snapshot_bytes;
    }
  } else if (input.event === '$exception') {
    const exceptions = sanitizeExceptionList(input.properties.$exception_list, surface);
    if (exceptions === null) return null;
    properties.$exception_list = exceptions;
    properties.$exception_level = 'error';
    properties.$geoip_disable = true;
  } else if (!input.event.startsWith('$')) {
    const allowedKeys = new Set(customKeys);
    for (const [key, value] of Object.entries(input.properties)) {
      if (
        !key.startsWith('$') &&
        (allowedKeys.has(key) || COMMON_CUSTOM_PROPERTY_KEYS.has(key)) &&
        isScalar(value)
      ) {
        properties[key] = value;
      }
    }
    const eventVersion = customEventVersionPolicy[input.event];
    if (Number.isInteger(eventVersion) && eventVersion >= 1) {
      properties.event_version = eventVersion;
    }
  }
  if (properties.telemetry_actor !== 'ci') delete properties.ci_run_id;

  const result: SdkCaptureEvent = { event: input.event, properties };
  if (isUuid(input.uuid)) result.uuid = input.uuid;
  if (input.timestamp !== undefined) result.timestamp = input.timestamp;
  if (input.event === '$identify' || input.event === '$set') {
    const personSet = sanitizePersonSet(input.$set ?? input.properties.$set);
    if (personSet) result.$set = personSet;
  }
  if (surface === 'web') {
    const firstTouch = sanitizeFirstTouch(input.$set_once ?? input.properties.$set_once);
    if (firstTouch) result.$set_once = firstTouch;
  }
  return result;
}

export function sanitizePostHogSdkEvent(
  ...args: Parameters<typeof sanitizeSdkEvent>
): SdkCaptureEvent | null {
  const event = sanitizeSdkEvent(...args);
  if (!event || event.event !== '$exception') return event;
  const list = event.properties.$exception_list;
  if (!Array.isArray(list)) return null;
  const exceptions: Record<string, unknown>[] = [];
  for (const exception of list) {
    if (
      !isRecord(exception) ||
      !isRecord(exception.stacktrace) ||
      !Array.isArray(exception.stacktrace.frames)
    )
      return null;
    const frames: Record<string, unknown>[] = [];
    for (const frame of exception.stacktrace.frames) {
      if (!isRecord(frame)) return null;
      frames.push({ ...frame, function: '<redacted>' });
    }
    exceptions.push({ ...exception, stacktrace: { ...exception.stacktrace, frames } });
  }
  return { ...event, properties: { ...event.properties, $exception_list: exceptions } };
}

const EXCEPTION_TYPES = new Set([
  'Error',
  'TypeError',
  'ReferenceError',
  'SyntaxError',
  'RangeError',
  'URIError',
  'EvalError',
  'AggregateError',
  'AbortError',
  'TimeoutError',
  'UnhandledRejection',
]);

function sanitizeExceptionList(
  value: unknown,
  surface: AnalyticsSurface
): Record<string, unknown>[] | null {
  if (!Array.isArray(value) || value.length === 0 || value.length > 5) return null;
  const exceptions: Record<string, unknown>[] = [];
  for (const exception of value) {
    if (
      !isRecord(exception) ||
      !isRecord(exception.stacktrace) ||
      !Array.isArray(exception.stacktrace.frames)
    )
      return null;
    const frames: Record<string, unknown>[] = [];
    for (const frame of exception.stacktrace.frames.slice(0, 30)) {
      if (!isRecord(frame) || typeof frame.filename !== 'string' || frame.filename.length > 4096)
        continue;
      if (
        typeof frame.lineno !== 'number' ||
        !Number.isSafeInteger(frame.lineno) ||
        frame.lineno < 1 ||
        frame.lineno > 2147483647
      )
        continue;
      const filename = exceptionFilename(frame.filename, surface);
      if (!filename) continue;
      const safe: Record<string, unknown> = {
        filename,
        lineno: frame.lineno,
        in_app: true,
        platform: filename.startsWith('app:///out/main/') ? 'node:javascript' : 'web:javascript',
      };
      if (
        typeof frame.colno === 'number' &&
        Number.isSafeInteger(frame.colno) &&
        frame.colno >= 0 &&
        frame.colno <= 2147483647
      )
        safe.colno = frame.colno;
      if (isUuid(frame.chunk_id)) safe.chunk_id = frame.chunk_id;
      frames.push(safe);
    }
    const mechanism = isRecord(exception.mechanism) ? exception.mechanism : {};
    exceptions.push({
      type:
        typeof exception.type === 'string' && EXCEPTION_TYPES.has(exception.type)
          ? exception.type
          : 'Error',
      value: 'Application exception',
      mechanism: {
        type: 'generic',
        handled: mechanism.handled === true,
        synthetic: mechanism.synthetic === true,
      },
      stacktrace: { type: 'raw', frames },
    });
  }
  return exceptions;
}

function exceptionFilename(value: string, surface: AnalyticsSurface): string | null {
  const normalized = value.replace(/\\/g, '/').split(/[?#]/, 1)[0];
  if (surface === 'desktop') {
    const match =
      /(?:\/app\.asar(?:\.unpacked)?|\/apps\/desktop)\/out\/((?:main|renderer|preload)\/[A-Za-z0-9_./-]+\.(?:js|mjs|cjs))$/.exec(
        normalized
      );
    if (!match || match[1].includes('..') || /[ACGT]{20,}/i.test(match[1])) return null;
    return `app:///out/${match[1]}`;
  }
  try {
    const url = new URL(value);
    if (
      !['https:', 'http:'].includes(url.protocol) ||
      !['dnaforge.com', 'www.dnaforge.com', 'localhost', '127.0.0.1', '[::1]'].includes(
        url.hostname
      )
    )
      return null;
    if (
      !/^\/_next\/static\/chunks\/[A-Za-z0-9_./()[\]%-]+\.js$/.test(url.pathname) ||
      /[ACGT]{20,}/i.test(url.pathname)
    )
      return null;
    return `https://www.dnaforge.com${url.pathname}`;
  } catch {
    return null;
  }
}

function acquisitionProperties(raw: Record<string, unknown>): Record<string, string> {
  const next: Record<string, string> = {};
  const referringDomain = referrerDomain(raw.$referrer);
  if (referringDomain) next.$referring_domain = referringDomain;
  for (const key of UTM_KEYS) {
    const value = attributionValue(raw[key]);
    if (value) next[key] = value;
  }
  return next;
}

function sanitizeFirstTouch(value: unknown): Record<string, string> | undefined {
  if (!isRecord(value)) return undefined;
  const next: Record<string, string> = {};
  const referringDomain =
    value.$initial_referring_domain === '$direct'
      ? '$direct'
      : typeof value.$initial_referring_domain === 'string' &&
          HOSTNAME_RE.test(value.$initial_referring_domain.toLowerCase())
        ? value.$initial_referring_domain.toLowerCase().replace(/^www\./, '')
        : referrerDomain(value.$initial_referrer);
  if (referringDomain) next.$initial_referring_domain = referringDomain;
  for (const key of UTM_KEYS) {
    const utm = attributionValue(value[`$initial_${key}`]);
    if (utm) next[`$initial_${key}`] = utm;
  }
  if (typeof value.$initial_pathname === 'string') {
    next.$initial_pathname = categorizeWebPath(value.$initial_pathname.split(/[?#]/)[0] ?? '/');
  }
  return Object.keys(next).length > 0 ? next : undefined;
}

function referrerDomain(value: unknown): string | undefined {
  if (value === '$direct' || value === '') return '$direct';
  if (typeof value !== 'string') return undefined;
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:' && url.protocol !== 'http:') return undefined;
    const hostname = url.hostname.toLowerCase().replace(/^www\./, '');
    return HOSTNAME_RE.test(hostname) ? hostname : undefined;
  } catch {
    return undefined;
  }
}

function attributionValue(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const normalized = value.trim().toLowerCase();
  return ATTRIBUTION_VALUE_RE.test(normalized) ? normalized : undefined;
}

export function acceptIdentityContext(
  current: AnalyticsIdentityContext | null,
  incoming: AnalyticsIdentityContext
): AnalyticsIdentityContext | null {
  if (!isValidIdentityContext(incoming)) return null;
  const sameRenderer =
    !current ||
    !current.rendererInstanceId ||
    !incoming.rendererInstanceId ||
    current.rendererInstanceId === incoming.rendererInstanceId;
  if (current && sameRenderer && incoming.generation <= current.generation) return null;
  return { ...incoming };
}

function categorizeWebPath(pathname: string): string {
  const normalized = pathname.length > 1 ? pathname.replace(/\/+$/, '') : pathname;
  if (/^\/designs\/[^/]+(?:\/.*)?$/.test(normalized)) return '/designs/:id';
  if (/^\/auth(?:\/|$)/.test(normalized)) return '/auth/*';
  if (/^\/admin(?:\/|$)/.test(normalized)) return '/admin/*';
  if (WEB_STATIC_ROUTES.has(normalized) || PUBLIC_BLOG_POST_PATH_SET.has(normalized))
    return normalized;
  if (PUBLIC_DOCS_PATH_RE.test(normalized)) return normalized;
  for (const [pattern, route] of WEB_ROUTE_PATTERNS) {
    if (pattern.test(normalized)) return normalized.replace(pattern, route);
  }
  return '/other';
}

function boundedBlogValue(value: unknown, allowed: ReadonlySet<string>): string | null {
  if (typeof value !== 'string' || value.length > 64) return null;
  const normalized = value.trim().toLowerCase();
  return allowed.has(normalized) ? normalized : null;
}

function blogReferrerSource(value: unknown): string {
  if (typeof value !== 'string' || !value || value === '$direct') return 'direct';
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:' && url.protocol !== 'http:') return 'unknown';
    const hostname = url.hostname.toLowerCase().replace(/^www\./, '');
    return BLOG_REFERRER_SOURCES[hostname] ?? 'other_referral';
  } catch {
    return 'unknown';
  }
}

function safePathname(url: string, surface: AnalyticsSurface): string {
  const parsed = new URL(url);
  return surface === 'desktop' ? parsed.pathname : categorizeWebPath(parsed.pathname);
}

function sanitizeElements(value: unknown): Array<Record<string, number | string>> {
  if (!Array.isArray(value)) return [];
  return value.slice(0, 16).flatMap((candidate) => {
    if (!isRecord(candidate) || typeof candidate.tag_name !== 'string') return [];
    const element: Record<string, number | string> = {
      tag_name: candidate.tag_name.toLowerCase().slice(0, 32),
    };
    if (isBoundedInteger(candidate.nth_child)) element.nth_child = candidate.nth_child;
    if (isBoundedInteger(candidate.nth_of_type)) element.nth_of_type = candidate.nth_of_type;
    const action = enumValue(
      candidate.attr__data_ph_capture_attribute_action,
      SAFE_AUTOCAPTURE_ACTION_SET
    );
    const surface = enumValue(
      candidate.attr__data_ph_capture_attribute_surface,
      SAFE_AUTOCAPTURE_SURFACE_SET
    );
    if (action) element.action = action;
    if (surface) element.surface = surface;
    return [element];
  });
}

function isBlockedElement(value: unknown): boolean {
  if (!isRecord(value)) return false;
  if (
    Object.prototype.hasOwnProperty.call(value, 'attr__data_ph_no_capture') ||
    Object.prototype.hasOwnProperty.call(value, 'attr__data_analytics_block')
  ) {
    return true;
  }
  return Array.isArray(value.classes) && value.classes.includes('ph-no-capture');
}

function enumValue(value: unknown, allowed: Set<string>): string | undefined {
  if (typeof value !== 'string') return undefined;
  const normalized = value.trim().toLowerCase();
  return allowed.has(normalized) ? normalized : undefined;
}

function organizationGroups(value: unknown): { organization: string } | undefined {
  if (!isRecord(value)) return undefined;
  const keys = Object.keys(value);
  return keys.length === 1 &&
    keys[0] === ANALYTICS_ORGANIZATION_GROUP &&
    isUuid(value[ANALYTICS_ORGANIZATION_GROUP])
    ? { organization: value[ANALYTICS_ORGANIZATION_GROUP] }
    : undefined;
}

function isUuid(value: unknown): value is string {
  return typeof value === 'string' && SAFE_UUID_RE.test(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isScalar(value: unknown): value is string | number | boolean {
  return typeof value === 'string' || typeof value === 'boolean' || isFiniteNumber(value);
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function isBoundedInteger(value: unknown): value is number {
  return Number.isInteger(value) && Number(value) >= 0 && Number(value) <= 10_000;
}

function isValidIdentityContext(value: AnalyticsIdentityContext): boolean {
  return (
    Number.isInteger(value.generation) &&
    value.generation >= 0 &&
    (value.kind === 'identified'
      ? isUuid(value.distinctId)
      : SAFE_OPAQUE_ID_RE.test(value.distinctId)) &&
    isUuid(value.sessionId) &&
    (value.rendererInstanceId === undefined || isUuid(value.rendererInstanceId)) &&
    ['anonymous', 'identified', 'fallback'].includes(value.kind)
  );
}
