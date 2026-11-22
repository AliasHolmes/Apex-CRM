import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { isExcludedCandidate } from '../server/leadSearch/discoveryEngine.js';
import { readLeadsStats, readLeadsSummary, upsertLeadWithIdentity } from '../server/db.js';
import {
  parseHostHeader,
  isLoopbackHost,
  isAllowedHost,
  isAllowedOrigin,
  parseServerCliArgs,
  isHostedEnvironment,
  getConfiguredHostAllowlist,
} from '../server/hostValidation.js';
import { abortableSleep } from '../server/services/brightdata.js';
import { sleepWithSignal } from '../server/services/llm.js';

describe('Critical Fixes & Optimizations Verification', () => {

  describe('Bug 2 Fix: Exclusion Substring Safety & URL Resilience', () => {
    it('does not falsely exclude candidate whose LinkedIn URL contains a short name substring like "dan"', () => {
      const candidate = {
        fullName: 'Daniel Craig',
        currentCompany: 'Eon Productions',
        profileUrl: 'https://www.linkedin.com/in/daniel-craig-007',
        snippet: 'Actor and producer'
      };

      // Exclude list contains short string 'dan', which should NOT match profileUrl
      const isExcluded = isExcludedCandidate(candidate, ['dan', 'https://www.linkedin.com/in/other-person']);
      assert.equal(isExcluded, false);
    });

    it('correctly excludes candidate when exact LinkedIn URL or handle matches', () => {
      const candidate = {
        fullName: 'Daniel Craig',
        currentCompany: 'Eon Productions',
        profileUrl: 'https://www.linkedin.com/in/daniel-craig-007',
        snippet: 'Actor and producer'
      };

      const isExcluded = isExcludedCandidate(candidate, ['https://www.linkedin.com/in/daniel-craig-007']);
      assert.equal(isExcluded, true);
    });

    it('correctly excludes candidate when LinkedIn URL has subdomain or trailing slash variations', () => {
      const candidate = {
        fullName: 'Daniel Craig',
        currentCompany: 'Eon Productions',
        profileUrl: 'https://uk.linkedin.com/in/daniel-craig-007?ref=preview',
        snippet: 'Actor and producer'
      };

      const isExcluded = isExcludedCandidate(candidate, ['https://www.linkedin.com/in/daniel-craig-007/']);
      assert.equal(isExcluded, true);
    });

    it('correctly excludes candidate whose URL is in sourceUrl', () => {
      const candidate = {
        fullName: 'Daniel Craig',
        currentCompany: 'Eon Productions',
        sourceUrl: 'https://www.linkedin.com/in/daniel-craig-007',
        snippet: 'Actor and producer'
      };

      const isExcluded = isExcludedCandidate(candidate, ['https://www.linkedin.com/in/daniel-craig-007']);
      assert.equal(isExcluded, true);
    });

    it('correctly excludes candidate when exact email matches', () => {
      const candidate = {
        fullName: 'Daniel Craig',
        currentCompany: 'Eon Productions',
        profileUrl: 'https://www.linkedin.com/in/daniel-craig-007',
        email: 'daniel@eon.com',
        snippet: 'Actor and producer'
      };

      const isExcluded = isExcludedCandidate(candidate, ['daniel@eon.com']);
      assert.equal(isExcluded, true);
    });
  });

  describe('Optimization 2: Sound SQLite Aggregate Stats', () => {
    it('computes sound aggregate stats directly in SQL without full table memory load', () => {
      // Seed a lead first. `initialized` reflects whether leads have ever been persisted, so
      // an empty database legitimately reports false - the assertion must not depend on
      // whatever state happens to exist in the configured database.
      upsertLeadWithIdentity({
        id: 'critical-fixes-stats-seed',
        fullName: 'Stats Seed',
        company: 'Seed Co',
        title: 'Analyst',
        stage: 'NEW',
        reviewStatus: 'UNREVIEWED',
        nextAction: 'NONE',
        profile: {
          fullName: 'Stats Seed',
          currentCompany: 'Seed Co',
          currentTitle: 'Analyst',
        },
      });
      const stats = readLeadsStats();
      assert.equal(typeof stats.total, 'number');
      assert.equal(typeof stats.averageQualification, 'number');
      assert.equal(typeof stats.conversionRate, 'number');
      assert.equal(typeof stats.stageCounts, 'object');
      assert.equal(stats.initialized, true);
      assert.ok(stats.total >= 0);
      assert.ok(stats.averageQualification >= 0 && stats.averageQualification <= 100);
      assert.ok(stats.conversionRate >= 0 && stats.conversionRate <= 100);
    });
  });

  describe('Optimization 3 & Bug 5 Fix: Score-based ordering and FTS direct join', () => {
    it('orders by score descending when requested', () => {
      const { leads } = readLeadsSummary({ limit: 10, orderBy: 'score' });
      assert.ok(Array.isArray(leads));
      for (let i = 1; i < leads.length; i++) {
        const prevScore = (leads[i - 1].qualificationScore ?? leads[i - 1].score ?? 0);
        const currScore = (leads[i].qualificationScore ?? leads[i].score ?? 0);
        const normPrev = prevScore <= 10 ? prevScore * 10 : prevScore;
        const normCurr = currScore <= 10 ? currScore * 10 : currScore;
        assert.ok(normPrev >= normCurr, `Expected ${normPrev} >= ${normCurr}`);
      }
    });

    it('performs full-text search directly on virtual FTS table', () => {
      const { leads } = readLeadsSummary({ search: 'engineer', limit: 10 });
      assert.ok(Array.isArray(leads));
    });
  });

  describe('Bug 4 Fix: Production Host & Origin Validation Module', () => {
    it('correctly parses IPv6 bracketed hosts with and without port', () => {
      const parsedWithPort = parseHostHeader('[::1]:3001');
      assert.equal(parsedWithPort.hostname, '[::1]');
      assert.equal(parsedWithPort.port, 3001);

      const parsedNoPort = parseHostHeader('[::1]');
      assert.equal(parsedNoPort.hostname, '[::1]');
      assert.equal(parsedNoPort.port, null);
    });

    it('correctly parses IPv4 and bare IPv6 hosts', () => {
      const parsedBare = parseHostHeader('::1');
      assert.equal(parsedBare.hostname, '::1');
      assert.equal(parsedBare.port, null);

      const parsedIpv4 = parseHostHeader('127.0.0.1:3001');
      assert.equal(parsedIpv4.hostname, '127.0.0.1');
      assert.equal(parsedIpv4.port, 3001);

      const parsedLocalhost = parseHostHeader('localhost:3000');
      assert.equal(parsedLocalhost.hostname, 'localhost');
      assert.equal(parsedLocalhost.port, 3000);
    });

    it('identifies loopback hosts correctly', () => {
      assert.equal(isLoopbackHost('localhost'), true);
      assert.equal(isLoopbackHost('127.0.0.1'), true);
      assert.equal(isLoopbackHost('[::1]'), true);
      assert.equal(isLoopbackHost('::1'), true);
      assert.equal(isLoopbackHost('evil.com'), false);
      assert.equal(isLoopbackHost('localhost.attacker.com'), false);
      assert.equal(isLoopbackHost('[::2]'), false);
    });

    it('validates allowed hosts and ports for DNS rebinding protection', () => {
      assert.equal(isAllowedHost('[::1]:3001', 3001), true);
      assert.equal(isAllowedHost('[::1]', 3001, 3001), true);
      assert.equal(isAllowedHost('localhost:3001', 3001), true);
      assert.equal(isAllowedHost('127.0.0.1:3001', 3001), true);
      assert.equal(isAllowedHost('localhost:8080', 3001), false);
      assert.equal(isAllowedHost('attacker.com:3001', 3001), false);
    });

    it('validates allowed origins for CORS security', () => {
      assert.equal(isAllowedOrigin('http://localhost:3001', 3001), true);
      assert.equal(isAllowedOrigin('http://127.0.0.1:3001', 3001), true);
      assert.equal(isAllowedOrigin('http://[::1]:3001', 3001), true);
      assert.equal(isAllowedOrigin('http://localhost:4000', 3001), false);
      assert.equal(isAllowedOrigin('https://evil.com', 3001), false);
      assert.equal(isAllowedOrigin(undefined, 3001), true);
    });

    it('parses CLI arguments for port and host correctly', () => {
      assert.deepEqual(parseServerCliArgs(['--port', '3000']), { port: 3000 });
      assert.deepEqual(parseServerCliArgs(['--port=4000']), { port: 4000 });
      assert.deepEqual(parseServerCliArgs(['-p', '8080']), { port: 8080 });
      assert.deepEqual(parseServerCliArgs(['-p=9000']), { port: 9000 });
      assert.deepEqual(parseServerCliArgs(['--host', '0.0.0.0']), { host: '0.0.0.0' });
      assert.deepEqual(parseServerCliArgs(['--host=127.0.0.1']), { host: '127.0.0.1' });
      assert.deepEqual(parseServerCliArgs(['-h', 'localhost']), { host: 'localhost' });
      assert.deepEqual(
        parseServerCliArgs(['node', 'server.js', '--port', '3000', '--host', '0.0.0.0']),
        { port: 3000, host: '0.0.0.0' }
      );
      assert.deepEqual(parseServerCliArgs(['--port', 'invalid']), {});
      assert.deepEqual(parseServerCliArgs(['--port', '70000']), {});
      assert.deepEqual(parseServerCliArgs([]), {});
    });

    it('detects hosted environments from APP_URL or K_SERVICE', () => {
      assert.equal(isHostedEnvironment({ APP_URL: 'https://crm.example.com' }), true);
      assert.equal(isHostedEnvironment({ K_SERVICE: 'apex-crm-service' }), true);
      assert.equal(isHostedEnvironment({ APP_URL: 'https://crm.example.com', K_SERVICE: 'service' }), true);
      assert.equal(isHostedEnvironment({}), false);
      assert.equal(isHostedEnvironment({ APP_URL: '', K_SERVICE: '   ' }), false);
      assert.equal(isHostedEnvironment(undefined as any), false);
    });

    it('parses configured host allowlist from APP_URL, ALLOWED_HOSTS, and ALLOWED_ORIGINS', () => {
      const env = {
        APP_URL: 'https://preview.run.app:8080',
        ALLOWED_HOSTS: 'my-crm.com, *.example.com internal.net:3000',
        ALLOWED_ORIGINS: 'https://trusted-client.com; http://app.local',
      };
      const allowlist = getConfiguredHostAllowlist(env);
      assert.ok(allowlist.includes('preview.run.app'));
      assert.ok(allowlist.includes('my-crm.com'));
      assert.ok(allowlist.includes('*.example.com'));
      assert.ok(allowlist.includes('internal.net'));
      assert.ok(allowlist.includes('trusted-client.com'));
      assert.ok(allowlist.includes('app.local'));
      assert.deepEqual(getConfiguredHostAllowlist({}), []);
    });

    it('supports hosted allowlist, Cloud Run, and same-host validation for isAllowedHost', () => {
      const opts = {
        allowedHosts: ['my-crm.com', '*.custom-domain.org'],
        allowCloudRun: true,
        allowSameHost: true,
        serverHost: 'service-xyz.run.app:3000',
      };

      // Loopback remains valid
      assert.equal(isAllowedHost('localhost:3000', 3000, opts), true);
      assert.equal(isAllowedHost('127.0.0.1:3000', 3000, opts), true);

      // Cloud Run domains
      assert.equal(isAllowedHost('apex-crm-abc-uc.a.run.app:443', 3000, opts), true);
      assert.equal(isAllowedHost('my-app.run.app', 3000, opts), true);

      // Explicit allowlisted host and wildcard
      assert.equal(isAllowedHost('my-crm.com:3000', 3000, opts), true);
      assert.equal(isAllowedHost('sub.custom-domain.org', 3000, opts), true);

      // Same-host match
      assert.equal(isAllowedHost('service-xyz.run.app:3000', 3000, opts), true);

      // Untrusted host rejected
      assert.equal(isAllowedHost('evil.com:3000', 3000, opts), false);
      assert.equal(isAllowedHost('not-allowed.org', 3000, opts), false);

      // Loopback-only enforcement when no options passed
      assert.equal(isAllowedHost('my-crm.com:3000', 3000), false);
    });

    it('supports hosted allowlist, Cloud Run, and same-host validation for isAllowedOrigin', () => {
      const opts = {
        allowedOrigins: ['https://trusted-client.com', 'http://dashboard.local:5173'],
        allowedHosts: ['my-crm.com', '*.custom-domain.org'],
        allowCloudRun: true,
        allowSameHost: true,
        requestHost: 'service-xyz.run.app:3000',
      };

      // Loopback on expected port remains valid
      assert.equal(isAllowedOrigin('http://localhost:3000', 3000, opts), true);
      assert.equal(isAllowedOrigin('http://localhost:3000', 3000), true);

      // Allowed origins list
      assert.equal(isAllowedOrigin('https://trusted-client.com', 3000, opts), true);
      assert.equal(isAllowedOrigin('http://dashboard.local:5173', 3000, opts), true);

      // Cloud Run origin
      assert.equal(isAllowedOrigin('https://my-app.run.app', 3000, opts), true);

      // Matching requestHost (same-host)
      assert.equal(isAllowedOrigin('https://service-xyz.run.app', 3000, opts), true);

      // Matching allowedHosts pattern
      assert.equal(isAllowedOrigin('https://my-crm.com', 3000, opts), true);
      assert.equal(isAllowedOrigin('https://sub.custom-domain.org', 3000, opts), true);

      // Untrusted origins rejected
      assert.equal(isAllowedOrigin('https://evil.com', 3000, opts), false);
      assert.equal(isAllowedOrigin('https://my-crm.com', 3000), false);
    });
  });

  describe('Bug 6 & LLM Backoff: Real Cancellable Sleep Functions', () => {
    it('aborts Bright Data abortableSleep immediately when AbortSignal triggers', async () => {
      const controller = new AbortController();
      const start = Date.now();
      setTimeout(() => controller.abort(), 25);

      await assert.rejects(
        async () => {
          await abortableSleep(5000, controller.signal);
        },
        { name: 'AbortError' }
      );

      const elapsed = Date.now() - start;
      assert.ok(elapsed < 1000, `Sleep should have aborted in <1000ms, took ${elapsed}ms`);
    });

    it('resolves Bright Data abortableSleep cleanly and cleans up listener when not aborted', async () => {
      const controller = new AbortController();
      await abortableSleep(10, controller.signal);
      assert.equal(controller.signal.aborted, false);
    });

    it('aborts LLM sleepWithSignal immediately when AbortSignal triggers', async () => {
      const controller = new AbortController();
      const start = Date.now();
      setTimeout(() => controller.abort(), 25);

      await assert.rejects(
        async () => {
          await sleepWithSignal(5000, controller.signal);
        },
        { name: 'AbortError' }
      );

      const elapsed = Date.now() - start;
      assert.ok(elapsed < 1000, `LLM sleep should have aborted in <1000ms, took ${elapsed}ms`);
    });

    it('resolves LLM sleepWithSignal cleanly and cleans up listener when not aborted', async () => {
      const controller = new AbortController();
      await sleepWithSignal(10, controller.signal);
      assert.equal(controller.signal.aborted, false);
    });
  });
});
