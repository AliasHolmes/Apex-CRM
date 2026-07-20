import * as crypto from 'crypto';

export type ApiKeyStatus = 'active' | 'rate_limited' | 'transient_cooldown' | 'exhausted';
export type ApiKeyFailureKind = 'rate_limited' | 'exhausted' | 'transient' | 'request_invalid' | 'unknown';

export type ApiKeySummary = {
  label: string;
  fingerprint: string;
  status: ApiKeyStatus;
  cooldownMsRemaining: number;
  lastFailureKind: ApiKeyFailureKind | null;
  lastStatusCode?: number;
  successes: number;
  failures: number;
  consecutiveTransientFailures: number;
};

export type ApiKeyPoolSummary = {
  provider: string;
  configured: boolean;
  total: number;
  active: number;
  rateLimited: number;
  transientCooldown: number;
  exhausted: number;
  keys: ApiKeySummary[];
};

export class KeyRotationError extends Error {
  statusCode?: number;
  responseText?: string;
  retryAfterMs?: number;

  constructor(message: string, options: {
    statusCode?: number;
    responseText?: string;
    retryAfterMs?: number;
  } = {}) {
    super(message);
    this.name = 'KeyRotationError';
    this.statusCode = options.statusCode;
    this.responseText = options.responseText;
    this.retryAfterMs = options.retryAfterMs;
  }
}

type ApiKeyEntry = {
  key: string;
  label: string;
  fingerprint: string;
  status: ApiKeyStatus;
  cooldownUntil: number;
  lastFailureKind: ApiKeyFailureKind | null;
  lastStatusCode?: number;
  successes: number;
  failures: number;
  consecutiveTransientFailures: number;
};

export type FailureClassification = {
  kind: ApiKeyFailureKind;
  statusCode?: number;
  cooldownMs?: number;
  message: string;
};

const DEFAULT_RATE_LIMIT_COOLDOWN_MS = 60_000;
const DEFAULT_TRANSIENT_COOLDOWN_MS = 15_000;
const TRANSIENT_FAILURES_BEFORE_COOLDOWN = 3;

const parseKeyValue = (value?: string) => {
  const raw = String(value || '').trim();
  if (!raw) return [];

  if (raw.startsWith('[')) {
    try {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) {
        return parsed.map(item => String(item || '').trim()).filter(Boolean);
      }
    } catch {
      // Fall back to comma parsing below for malformed operator input.
    }
  }

  return raw.split(',').map(item => item.trim()).filter(Boolean);
};

export function parseApiKeys(primary?: string, fallbacks: Array<string | undefined> = []) {
  const sourceKeys = [primary, ...fallbacks]
    .flatMap(value => parseKeyValue(value));
  return Array.from(new Set(sourceKeys));
}

const statusCodeFromError = (error: unknown) => {
  const anyError = error as any;
  if (typeof anyError?.statusCode === 'number') return anyError.statusCode;
  if (typeof anyError?.status === 'number') return anyError.status;
  const message = error instanceof Error ? error.message : String(error);
  const match = message.match(/\b(?:HTTP|status|error)\s*:?\s*(\d{3})\b/i) || message.match(/\b(4\d{2}|5\d{2})\b/);
  return match ? Number(match[1]) : undefined;
};

const retryAfterMsFromError = (error: unknown) => {
  const anyError = error as any;
  if (typeof anyError?.retryAfterMs === 'number' && Number.isFinite(anyError.retryAfterMs)) {
    return Math.max(0, anyError.retryAfterMs);
  }
  const retryAfter = anyError?.retryAfter;
  if (typeof retryAfter === 'number' && Number.isFinite(retryAfter)) return Math.max(0, retryAfter * 1000);
  if (typeof retryAfter === 'string') {
    const numeric = Number(retryAfter);
    if (Number.isFinite(numeric)) return Math.max(0, numeric * 1000);
    const dateMs = Date.parse(retryAfter);
    if (Number.isFinite(dateMs)) return Math.max(0, dateMs - Date.now());
  }
  return undefined;
};

export function classifyKeyRotationError(error: unknown): FailureClassification {
  const anyError = error as any;
  const message = error instanceof Error ? error.message : String(error);
  const responseText = typeof anyError?.responseText === 'string' ? anyError.responseText : '';
  const lower = `${message}\n${responseText}`.toLowerCase();
  const statusCode = statusCodeFromError(error);

  if (statusCode === 400 || /validation failed|bad request|invalid request|invalid parameter|parameter validation/.test(lower)) {
    return { kind: 'request_invalid', statusCode, message };
  }

  if (statusCode === 429 || /too many requests|rate limit|rate_limit|rate limited/.test(lower)) {
    return {
      kind: 'rate_limited',
      statusCode,
      cooldownMs: retryAfterMsFromError(error) ?? DEFAULT_RATE_LIMIT_COOLDOWN_MS,
      message
    };
  }

  if (
    statusCode === 401 ||
    statusCode === 402 ||
    statusCode === 403 ||
    /unauthorized|forbidden|invalid token|invalid api key|api[_ -]?token|credit|quota|billing|payment|balance|usage limit|limit exceeded/.test(lower)
  ) {
    return { kind: 'exhausted', statusCode, message };
  }

  if (!statusCode || statusCode >= 500 || /econnreset|socket hang up|fetch failed|network|timeout|timed out|connection closed/.test(lower)) {
    return { kind: 'transient', statusCode, cooldownMs: DEFAULT_TRANSIENT_COOLDOWN_MS, message };
  }

  return { kind: 'unknown', statusCode, message };
}

export class ApiKeyPool {
  private entries = new Map<string, ApiKeyEntry>();
  private order: string[] = [];
  private nextIndex = 0;
  private signature = '';

  constructor(
    readonly provider: string,
    private readonly loadKeys: () => string[]
  ) {}

  hasConfiguredKeys() {
    this.refresh();
    return this.order.length > 0;
  }

  hasAvailableKey(now = Date.now()) {
    this.refresh(now);
    return this.order.some(key => this.isUsable(this.entries.get(key), now));
  }

  getStatus(now = Date.now()): ApiKeyPoolSummary {
    this.refresh(now);
    const keys = this.order.map(key => this.toSummary(this.entries.get(key)!, now));
    return {
      provider: this.provider,
      configured: this.order.length > 0,
      total: keys.length,
      active: keys.filter(key => key.status === 'active').length,
      rateLimited: keys.filter(key => key.status === 'rate_limited').length,
      transientCooldown: keys.filter(key => key.status === 'transient_cooldown').length,
      exhausted: keys.filter(key => key.status === 'exhausted').length,
      keys
    };
  }

  nextKey(skipped = new Set<string>(), now = Date.now()) {
    this.refresh(now);
    if (this.order.length === 0) {
      throw new Error(`${this.provider} API key is not configured.`);
    }

    for (let offset = 0; offset < this.order.length; offset++) {
      const index = (this.nextIndex + offset) % this.order.length;
      const key = this.order[index];
      if (skipped.has(key)) continue;
      const entry = this.entries.get(key);
      if (!this.isUsable(entry, now)) continue;
      this.nextIndex = (index + 1) % this.order.length;
      return { key, label: entry!.label, fingerprint: entry!.fingerprint };
    }

    throw new Error(`No healthy ${this.provider} API keys are available.`);
  }

  markSuccess(key: string) {
    const entry = this.entries.get(key);
    if (!entry) return;
    entry.status = 'active';
    entry.cooldownUntil = 0;
    entry.lastFailureKind = null;
    entry.lastStatusCode = undefined;
    entry.consecutiveTransientFailures = 0;
    entry.successes++;
  }

  markFailure(key: string, classification: FailureClassification, now = Date.now()) {
    const entry = this.entries.get(key);
    if (!entry) return;
    entry.failures++;
    entry.lastFailureKind = classification.kind;
    entry.lastStatusCode = classification.statusCode;

    if (classification.kind === 'rate_limited') {
      entry.status = 'rate_limited';
      entry.cooldownUntil = now + (classification.cooldownMs ?? DEFAULT_RATE_LIMIT_COOLDOWN_MS);
      entry.consecutiveTransientFailures = 0;
      return;
    }

    if (classification.kind === 'exhausted') {
      entry.status = 'exhausted';
      entry.cooldownUntil = 0;
      entry.consecutiveTransientFailures = 0;
      return;
    }

    if (classification.kind === 'transient') {
      entry.consecutiveTransientFailures++;
      if (entry.consecutiveTransientFailures >= TRANSIENT_FAILURES_BEFORE_COOLDOWN) {
        entry.status = 'transient_cooldown';
        entry.cooldownUntil = now + (classification.cooldownMs ?? DEFAULT_TRANSIENT_COOLDOWN_MS);
      }
    }
  }

  reset() {
    this.entries.clear();
    this.order = [];
    this.nextIndex = 0;
    this.signature = '';
    this.refresh();
  }

  private refresh(now = Date.now()) {
    const keys = this.loadKeys();
    const signature = keys.join('\n');
    if (signature !== this.signature) {
      const previous = this.entries;
      this.entries = new Map();
      this.order = keys;
      keys.forEach((key, index) => {
        const existing = previous.get(key);
        this.entries.set(key, existing || {
          key,
          label: `key_${index + 1}`,
          fingerprint: fingerprintKey(key),
          status: 'active',
          cooldownUntil: 0,
          lastFailureKind: null,
          successes: 0,
          failures: 0,
          consecutiveTransientFailures: 0
        });
      });
      this.nextIndex = 0;
      this.signature = signature;
    }

    for (const entry of this.entries.values()) {
      if ((entry.status === 'rate_limited' || entry.status === 'transient_cooldown') && entry.cooldownUntil <= now) {
        entry.status = 'active';
        entry.cooldownUntil = 0;
        entry.consecutiveTransientFailures = 0;
      }
    }
  }

  private isUsable(entry: ApiKeyEntry | undefined, now: number) {
    if (!entry || entry.status === 'exhausted') return false;
    return entry.status === 'active' || entry.cooldownUntil <= now;
  }

  private toSummary(entry: ApiKeyEntry, now: number): ApiKeySummary {
    return {
      label: entry.label,
      fingerprint: entry.fingerprint,
      status: entry.status,
      cooldownMsRemaining: Math.max(0, entry.cooldownUntil - now),
      lastFailureKind: entry.lastFailureKind,
      lastStatusCode: entry.lastStatusCode,
      successes: entry.successes,
      failures: entry.failures,
      consecutiveTransientFailures: entry.consecutiveTransientFailures
    };
  }
}

export async function executeWithKeyRotation<T>(
  pool: ApiKeyPool,
  action: (key: string) => Promise<T>
): Promise<T> {
  const attempted = new Set<string>();
  const failures: Error[] = [];

  while (attempted.size < pool.getStatus().total) {
    const selected = pool.nextKey(attempted);
    attempted.add(selected.key);

    try {
      const result = await action(selected.key);
      pool.markSuccess(selected.key);
      return result;
    } catch (error) {
      const classification = classifyKeyRotationError(error);
      if (classification.kind === 'request_invalid' || classification.kind === 'unknown') {
        throw error;
      }
      pool.markFailure(selected.key, classification);
      failures.push(error instanceof Error ? error : new Error(String(error)));
    }
  }

  throw new Error(`All configured ${pool.provider} API keys failed: ${failures.map(error => error.message).join(' | ')}`);
}

function fingerprintKey(key: string) {
  return crypto.createHash('sha256').update(key).digest('hex').slice(0, 8);
}
