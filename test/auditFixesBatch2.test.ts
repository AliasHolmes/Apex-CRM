/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import type { Server } from 'node:http';
import express from 'express';

const testDbPath = path.join(
  os.tmpdir(),
  `test-audit-batch2-${Date.now()}-${Math.random().toString(36).slice(2)}.sqlite`,
);
process.env.APEX_DB_PATH = testDbPath;

import { toSafeHttpUrl } from '../src/lib/safeUrl.js';
import {
  isPlaceholderProfileValue,
  enrichLeadProfile,
} from '../server/leadSearch/profileEnrichment.js';
import { executeAgentBrainDiscovery } from '../server/leadSearch/agentBrainRunner.js';
import {
  getLeadsDb,
  upsertLeadWithIdentity,
  upsertEnrichmentCacheEntry,
  readMiningSessionById,
} from '../server/db.js';
import apiRouter from '../server/routes/api.js';

test('toSafeHttpUrl preserves safe HTTP/HTTPS URLs and auto-prefixes domain-like inputs', () => {
  // Safe valid URLs
  assert.equal(toSafeHttpUrl('https://example.com/profile'), 'https://example.com/profile');
  assert.equal(toSafeHttpUrl('http://insecure.test/page?a=1'), 'http://insecure.test/page?a=1');
  assert.equal(
    toSafeHttpUrl('https://www.linkedin.com/in/john-doe-123/'),
    'https://www.linkedin.com/in/john-doe-123/',
  );

  // Auto-prefixing valid domain-like strings
  assert.equal(toSafeHttpUrl('example.com'), 'https://example.com/');
  assert.equal(toSafeHttpUrl('linkedin.com/in/alice'), 'https://linkedin.com/in/alice');
  assert.equal(toSafeHttpUrl('sub.domain.co.uk/path?q=1#hash'), 'https://sub.domain.co.uk/path?q=1#hash');
  assert.equal(toSafeHttpUrl('//cdn.example.org/asset.js'), 'https://cdn.example.org/asset.js');
  assert.equal(toSafeHttpUrl('http://localhost:3000/api'), 'http://localhost:3000/api');
});

test('toSafeHttpUrl strictly rejects malicious schemes, whitespace, and control characters', () => {
  // Malicious / non-HTTP schemes
  assert.equal(toSafeHttpUrl('javascript:alert(1)'), null);
  assert.equal(toSafeHttpUrl('data:text/html,<script>alert(1)</script>'), null);
  assert.equal(toSafeHttpUrl('vbscript:msgbox(1)'), null);
  assert.equal(toSafeHttpUrl('file:///etc/passwd'), null);
  assert.equal(toSafeHttpUrl('about:blank'), null);

  // Whitespace and control characters
  assert.equal(toSafeHttpUrl('https://example.com/path with space'), null);
  assert.equal(toSafeHttpUrl('https://example.com\nnewline'), null);
  assert.equal(toSafeHttpUrl('https://example.com\r\nCRLF'), null);
  assert.equal(toSafeHttpUrl('https://example.com\x00nullbyte'), null);
  assert.equal(toSafeHttpUrl('https://example.com\tTab'), null);

  // Invalid or empty inputs
  assert.equal(toSafeHttpUrl(''), null);
  assert.equal(toSafeHttpUrl('   '), null);
  assert.equal(toSafeHttpUrl(null), null);
  assert.equal(toSafeHttpUrl(undefined), null);
  assert.equal(toSafeHttpUrl(12345 as any), null);
  assert.equal(toSafeHttpUrl('///triple-slash'), null);
});

test('isPlaceholderProfileValue recognizes known placeholder defaults and rejects genuine values', () => {
  const placeholders = [
    'unknown',
    'UNKNOWN',
    '  unknown  ',
    'independent',
    'INDEPENDENT',
    'professional',
    'Professional',
    'undisclosed location',
    'UNDISCLOSED LOCATION',
    'professional @ independent',
    'Professional @ Independent',
    'n/a',
    'N/A',
    'none',
    'NONE',
  ];

  for (const val of placeholders) {
    assert.equal(
      isPlaceholderProfileValue(val),
      true,
      `Expected "${val}" to be classified as placeholder`,
    );
  }

  const genuineValues = [
    'CEO',
    'Founder & Managing Partner',
    'Acme Corporation',
    'Stripe, Inc.',
    'San Francisco, CA',
    'London, United Kingdom',
    'Software Engineer',
    'Head of Growth',
  ];

  for (const val of genuineValues) {
    assert.equal(
      isPlaceholderProfileValue(val),
      false,
      `Expected "${val}" NOT to be classified as placeholder`,
    );
  }

  // Non-string or empty inputs
  assert.equal(isPlaceholderProfileValue(''), false);
  assert.equal(isPlaceholderProfileValue(null), false);
  assert.equal(isPlaceholderProfileValue(undefined), false);
  assert.equal(isPlaceholderProfileValue(123), false);
});

test('enrichLeadProfile overwrites placeholder fields with enriched data from cache', async () => {
  const testUrl = 'https://www.linkedin.com/in/placeholder-overwrite-test';
  const now = new Date();

  // Seed enrichment cache with genuine data
  upsertEnrichmentCacheEntry(
    {
      normalizedUrl: 'linkedin.com/in/placeholder-overwrite-test',
      linkedinUsername: 'placeholder-overwrite-test',
      personName: 'Elena Rostova',
      companyName: 'Apex Dynamics',
      publicEmail: 'elena@apexdynamics.io',
      evidenceBlock:
        'NAME: Elena Rostova\nTITLE: Chief Technology Officer\nHEADLINE: Chief Technology Officer at Apex Dynamics\nLOCATION: Austin, TX\nINDUSTRY: Enterprise Software',
      scrapeQuality: 'good',
      sourceProvider: 'brightdata',
    },
    7,
    now,
  );

  // Lead profile currently populated with placeholder defaults
  const leadWithPlaceholders = {
    id: 'lead-enrich-placeholder-1',
    profile: {
      fullName: 'Elena Rostova',
      currentTitle: 'professional',
      currentCompany: 'independent',
      location: 'undisclosed location',
      industry: 'n/a',
      contactDetails: {
        linkedinUrl: testUrl,
      },
    },
  };

  const { lead: enrichedLead, result } = await enrichLeadProfile(leadWithPlaceholders);

  assert.equal(result.cacheHit, true);
  assert.equal(enrichedLead.profile.currentTitle, 'Chief Technology Officer');
  assert.equal(enrichedLead.profile.currentCompany.toLowerCase(), 'apex dynamics');
  assert.equal(enrichedLead.profile.location, 'Austin, TX');
  assert.equal(enrichedLead.profile.industry, 'Enterprise Software');
  assert.equal(enrichedLead.profile.contactDetails.email, 'elena@apexdynamics.io');

  assert.ok(result.updatedFields.includes('currentTitle'));
  assert.ok(result.updatedFields.includes('currentCompany'));
  assert.ok(result.updatedFields.includes('location'));
  assert.ok(result.updatedFields.includes('industry'));
  assert.ok(result.updatedFields.includes('email'));
});

test('executeAgentBrainDiscovery aborts cleanly and persists cancelled status without overwrite', async () => {
  const sessionId = `test-agent-cancel-${Date.now()}`;
  const controller = new AbortController();

  // Pre-abort the signal before running discovery
  controller.abort();

  const result = await executeAgentBrainDiscovery(
    {
      sessionId,
      promptQuery: 'Founders in Austin Texas',
      requestedLimit: 25,
      stage: 'SCRAPED',
    },
    controller.signal,
  );

  assert.equal(result.sessionId, sessionId);
  assert.equal(result.stats?.status, 'cancelled');
  assert.equal(result.leads.length, 0);

  const sessionRow = readMiningSessionById(sessionId);
  assert.ok(sessionRow);
  assert.equal(sessionRow.status, 'cancelled');
  assert.equal(sessionRow.errorMessage, 'Agent Brain discovery was cancelled.');
});

// Express Server Suite for API Input Validation and Bulk Feedback
test('API routes input validation and POST /leads/bulk query_performance feedback', async (t) => {
  const app = express();
  app.use(express.json());
  app.use('/api', apiRouter);

  let server: Server;
  let baseUrl: string;

  await new Promise<void>((resolve) => {
    server = app.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      if (typeof addr === 'object' && addr !== null) {
        baseUrl = `http://127.0.0.1:${addr.port}/api`;
      }
      resolve();
    });
  });

  t.after(async () => {
    await new Promise<void>((resolve) => {
      server.closeAllConnections?.();
      server.close(() => resolve());
    });
  });

  await t.test('POST /scrape-url validates input: 400 on empty/missing/oversized, 422 on short text', async () => {
    // 400 on missing body
    const resEmpty = await fetch(`${baseUrl}/scrape-url`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });
    assert.equal(resEmpty.status, 400);
    const bodyEmpty = await resEmpty.json();
    assert.match(bodyEmpty.error, /urlOrName is required/);

    // 400 on whitespace string
    const resWhitespace = await fetch(`${baseUrl}/scrape-url`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ urlOrName: '   ' }),
    });
    assert.equal(resWhitespace.status, 400);

    // 400 on URL > 500 characters
    const longUrl = 'https://example.com/' + 'a'.repeat(501);
    const resLong = await fetch(`${baseUrl}/scrape-url`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ urlOrName: longUrl }),
    });
    assert.equal(resLong.status, 400);
    const bodyLong = await resLong.json();
    assert.match(bodyLong.error, /500 characters or fewer/);
  });

  await t.test('POST /scrape-pasted validates input: 400 on too-short text', async () => {
    const resShort = await fetch(`${baseUrl}/scrape-pasted`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ pastedText: 'short' }),
    });
    assert.equal(resShort.status, 400);
    const bodyShort = await resShort.json();
    assert.match(bodyShort.error, /minimum 20 characters/);
  });

  await t.test('POST /generate-outbound validates input: 400 on missing or oversized fullName', async () => {
    // 400 on missing profile
    const resNoProfile = await fetch(`${baseUrl}/generate-outbound`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });
    assert.equal(resNoProfile.status, 400);
    const bodyNoProfile = await resNoProfile.json();
    assert.match(bodyNoProfile.error, /profile\.fullName is required/);

    // 400 on empty profile.fullName
    const resEmptyName = await fetch(`${baseUrl}/generate-outbound`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ profile: { fullName: '   ' } }),
    });
    assert.equal(resEmptyName.status, 400);

    // 400 on profile.fullName > 200 characters
    const longName = 'A'.repeat(201);
    const resLongName = await fetch(`${baseUrl}/generate-outbound`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ profile: { fullName: longName } }),
    });
    assert.equal(resLongName.status, 400);
    const bodyLongName = await resLongName.json();
    assert.match(bodyLongName.error, /200 characters or fewer/);
  });

  await t.test('POST /outreach-drafts sanitizes wordCount and validates bounds', async () => {
    const draftId = `draft-test-${Date.now()}`;
    const leadId = `lead-draft-${Date.now()}`;

    // Missing required fields
    const resMissing = await fetch(`${baseUrl}/outreach-drafts`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: draftId }),
    });
    assert.equal(resMissing.status, 400);

    // Negative wordCount sanitized to 0
    const resNegativeWordCount = await fetch(`${baseUrl}/outreach-drafts`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        id: draftId,
        leadId,
        leadName: 'Jane Test',
        companyName: 'Test Corp',
        tone: 'professional',
        body: 'Hello, this is a test draft body.',
        wordCount: -15,
      }),
    });
    assert.equal(resNegativeWordCount.status, 200);
    const bodyNegative = await resNegativeWordCount.json();
    assert.ok(bodyNegative.draft);
    assert.equal(bodyNegative.draft.wordCount, 0);

    // Float wordCount sanitized to floor integer
    const draftId2 = `draft-test-2-${Date.now()}`;
    const resFloatWordCount = await fetch(`${baseUrl}/outreach-drafts`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        id: draftId2,
        leadId,
        leadName: 'Jane Test',
        companyName: 'Test Corp',
        tone: 'casual',
        body: 'Hello, another draft body.',
        wordCount: 142.9,
      }),
    });
    assert.equal(resFloatWordCount.status, 200);
    const bodyFloat = await resFloatWordCount.json();
    assert.ok(bodyFloat.draft);
    assert.equal(bodyFloat.draft.wordCount, 142);
  });

  await t.test('POST /leads/bulk records query_performance feedback identically to single lead PATCH', async () => {
    const testLeadId = `lead-bulk-perf-${Date.now()}`;
    const scopeKey = `test-cluster-perf|founder|person|tavily`;

    // Seed unreviewed lead with discovery scope key
    upsertLeadWithIdentity({
      id: testLeadId,
      profile: {
        fullName: 'Marcus Vance',
        currentCompany: 'Vance Tech',
        currentTitle: 'Founder',
        industry: 'Software',
      },
      stage: 'SCRAPED',
      reviewStatus: 'UNREVIEWED',
      nextAction: 'NONE',
      discoveryScopeKey: scopeKey,
      discoveryFamily: 'founder',
      discoveryLane: 'person',
      createdAt: new Date().toISOString(),
    });

    const initialDb = getLeadsDb();
    const initialPerf = initialDb
      .prepare('SELECT outcome_runs, qualified_candidates, hard_failed_candidates FROM query_performance WHERE scope_key = ?')
      .get(scopeKey) as any;
    const initialOutcomes = initialPerf?.outcome_runs || 0;
    const initialQualified = initialPerf?.qualified_candidates || 0;

    // Transition via POST /leads/bulk to KEEP (verified positive outcome)
    const resBulkApprove = await fetch(`${baseUrl}/leads/bulk`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        leads: [
          {
            id: testLeadId,
            revision: 1,
            stage: 'SCRAPED',
            reviewStatus: 'KEEP',
            discoveryScopeKey: scopeKey,
            discoveryFamily: 'founder',
            discoveryLane: 'person',
            profile: {
              fullName: 'Marcus Vance',
              currentCompany: 'Vance Tech',
              currentTitle: 'Founder',
              industry: 'Software',
            },
          },
        ],
        forceOverwrite: true,
      }),
    });

    assert.equal(resBulkApprove.status, 200);
    const bodyBulk = await resBulkApprove.json();
    assert.equal(bodyBulk.success, true);
    assert.equal(bodyBulk.updatedCount, 1);

    // Verify query_performance feedback was recorded
    const updatedPerf = initialDb
      .prepare('SELECT outcome_runs, qualified_candidates, hard_failed_candidates FROM query_performance WHERE scope_key = ?')
      .get(scopeKey) as any;

    assert.ok(updatedPerf, 'query_performance row must exist for scope_key');
    assert.equal(updatedPerf.outcome_runs, initialOutcomes + 1);
    assert.equal(updatedPerf.qualified_candidates, initialQualified + 1);
  });
});
