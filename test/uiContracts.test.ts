import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import {
  DASHBOARD_NAV_ITEMS,
  getHashForTab,
  getTabFromHash,
} from '../src/lib/navigation';
import {
  getPipelineStageDomId,
  NEXT_PIPELINE_STAGE,
  PIPELINE_STAGE_IDS,
  PIPELINE_STAGES,
  PREVIOUS_PIPELINE_STAGE,
} from '../src/lib/pipeline';
import {
  DEFAULT_MANUAL_INDUSTRY,
  isDiscoveryProviderConfigured,
  MANUAL_PROSPECT_INDUSTRIES,
  PROSPECTS_PAGE_SIZE,
} from '../src/lib/ui';
import {
  NEXT_ACTION_OPTIONS,
  REVIEW_STATUS_OPTIONS,
} from '../src/lib/prospectWorkflow';

function collectTsxFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const entryPath = path.join(directory, entry.name);
    if (entry.isDirectory()) return collectTsxFiles(entryPath);
    return entry.isFile() && entry.name.endsWith('.tsx') ? [entryPath] : [];
  });
}

test('dashboard navigation hashes round-trip without duplicate labels or routes', () => {
  assert.equal(new Set(DASHBOARD_NAV_ITEMS.map((item) => item.id)).size, DASHBOARD_NAV_ITEMS.length);
  assert.equal(new Set(DASHBOARD_NAV_ITEMS.map((item) => item.hash)).size, DASHBOARD_NAV_ITEMS.length);
  assert.equal(new Set(DASHBOARD_NAV_ITEMS.map((item) => item.label)).size, DASHBOARD_NAV_ITEMS.length);

  for (const item of DASHBOARD_NAV_ITEMS) {
    assert.equal(getTabFromHash(getHashForTab(item.id)), item.id);
  }

  assert.equal(getTabFromHash('#workspace'), 'workspace');
  assert.equal(getTabFromHash('#inventory'), 'inventory');
  assert.equal(getTabFromHash('#unknown'), 'overview');
});

test('pipeline metadata is complete, unique, and internally consistent', () => {
  const expectedStages = [
    'SCRAPED',
    'ENRICHED',
    'SEQUENCE ACTIVE',
    'REPLIED',
    'MEETING BOOKED',
    'NEGOTIATING',
    'CONVERTED',
    'NURTURE',
    'LOST',
  ];

  assert.deepEqual([...PIPELINE_STAGE_IDS].sort(), [...expectedStages].sort());
  assert.equal(new Set(PIPELINE_STAGE_IDS).size, PIPELINE_STAGES.length);

  for (const [source, destination] of Object.entries(NEXT_PIPELINE_STAGE)) {
    assert.ok(PIPELINE_STAGE_IDS.includes(source as (typeof PIPELINE_STAGE_IDS)[number]));
    assert.ok(PIPELINE_STAGE_IDS.includes(destination));
  }

  assert.deepEqual(PREVIOUS_PIPELINE_STAGE, {
    ENRICHED: 'SCRAPED',
    'SEQUENCE ACTIVE': 'ENRICHED',
    REPLIED: 'SEQUENCE ACTIVE',
    'MEETING BOOKED': 'REPLIED',
    NEGOTIATING: 'MEETING BOOKED',
    CONVERTED: 'NEGOTIATING',
  });
  assert.equal(PREVIOUS_PIPELINE_STAGE.NURTURE, undefined);
  assert.equal(PREVIOUS_PIPELINE_STAGE.LOST, undefined);

  const stageDomIds = PIPELINE_STAGE_IDS.map(getPipelineStageDomId);
  assert.equal(new Set(stageDomIds).size, PIPELINE_STAGE_IDS.length);
  assert.ok(stageDomIds.every((id) => /^pipeline-stage-[a-z0-9-]+$/.test(id)));
});

test('prospect UI defaults remain valid and inventory stays at 100 rows per page', () => {
  assert.equal(PROSPECTS_PAGE_SIZE, 100);
  assert.ok(MANUAL_PROSPECT_INDUSTRIES.includes(DEFAULT_MANUAL_INDUSTRY));
  assert.deepEqual(REVIEW_STATUS_OPTIONS.map(option => option.value), ['UNREVIEWED', 'KEEP', 'MAYBE', 'REJECT']);
  assert.deepEqual(NEXT_ACTION_OPTIONS.map(option => option.value), ['NONE', 'OPEN_LINKEDIN', 'RESEARCH', 'CONNECT', 'MESSAGE']);
});

test('prospect UI keeps email while exposing no dedicated discovery controls', () => {
  const leadTable = readFileSync(path.resolve('src/components/LeadTable.tsx'), 'utf8');
  const scrapeWorkspace = readFileSync(path.resolve('src/components/ScrapeWorkspace.tsx'), 'utf8');
  const types = readFileSync(path.resolve('src/types.ts'), 'utf8');
  const combined = `${leadTable}\n${scrapeWorkspace}\n${types}`;
  assert.doesNotMatch(combined, /find-email|email-discovery|forceEmailDiscovery|forceProfileScrape|lastReviewedAt|followUpAt/);
  assert.match(types, /email\?: string/);
  assert.match(leadTable, /Review status/);
  assert.match(leadTable, /Next action/);
});

test('discovery readiness requires both an LLM and a retrieval provider', () => {
  assert.equal(isDiscoveryProviderConfigured({ hasKey: true }), false);
  assert.equal(isDiscoveryProviderConfigured({ hasTavilyKey: true }), false);
  assert.equal(isDiscoveryProviderConfigured({ hasKey: true, hasTavilyKey: true }), true);
  assert.equal(
    isDiscoveryProviderConfigured({ hasKey: true, brightData: { configured: true } }),
    true,
  );
  assert.equal(
    isDiscoveryProviderConfigured({
      hasKey: true,
      providerCapabilities: { brightData: { configured: true } },
    }),
    true,
  );
});

test('UI source avoids unreadable type sizes and undefined project color scales', () => {
  const violations: string[] = [];
  const tinyTextPattern = /text-\[(?:[0-9]|1[01])px\]/g;
  const undefinedColorPattern = /\b(?:indigo|rose|amber|blue)-(?:350|450|505|550|650|850)\b/g;

  for (const file of collectTsxFiles(path.resolve('src'))) {
    const source = readFileSync(file, 'utf8');
    for (const pattern of [tinyTextPattern, undefinedColorPattern]) {
      pattern.lastIndex = 0;
      const matches = [...source.matchAll(pattern)];
      if (matches.length > 0) {
        violations.push(`${path.relative(process.cwd(), file)}: ${matches.map((match) => match[0]).join(', ')}`);
      }
    }
  }

  assert.deepEqual(violations, []);
});
