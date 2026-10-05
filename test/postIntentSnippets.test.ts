import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  isLinkedInPostUrl,
  isSerpBoilerplate,
  extractPostSnippets,
} from '../server/leadSearch/linkedinPostIntent.js';

test('isLinkedInPostUrl accepts genuine LinkedIn post and activity URLs', () => {
  assert.ok(isLinkedInPostUrl('https://www.linkedin.com/posts/johndoe_automation-activity-12345'));
  assert.ok(isLinkedInPostUrl('https://linkedin.com/posts/johndoe_hiring-67890'));
  assert.ok(isLinkedInPostUrl('https://nz.linkedin.com/posts/johndoe_ai-consultancy-11111'));
  assert.ok(isLinkedInPostUrl('https://www.linkedin.com/pulse/future-of-ai-automation-johndoe/'));
  assert.ok(isLinkedInPostUrl('https://www.linkedin.com/feed/update/urn:li:activity:99999/'));
  assert.ok(isLinkedInPostUrl('https://www.linkedin.com/activity/feed/'));
  assert.ok(isLinkedInPostUrl('https://www.linkedin.com/in/johndoe/recent-activity/'));
  assert.ok(isLinkedInPostUrl('https://www.linkedin.com/in/johndoe/recent-activity/all/'));
});

test('isLinkedInPostUrl rejects bare profile pages and non-LinkedIn URLs', () => {
  assert.strictEqual(isLinkedInPostUrl('https://www.linkedin.com/in/johndoe'), false);
  assert.strictEqual(isLinkedInPostUrl('https://www.linkedin.com/in/johndoe/'), false);
  assert.strictEqual(isLinkedInPostUrl('https://michaels.com/crafts/knitting'), false);
  assert.strictEqual(isLinkedInPostUrl('https://www.bing.com/ck/a?!&&p=12345'), false);
  assert.strictEqual(isLinkedInPostUrl(''), false);
  assert.strictEqual(isLinkedInPostUrl(null as any), false);
});

test('isSerpBoilerplate identifies known search engine UI strings', () => {
  assert.ok(isSerpBoilerplate('Visual Search - click to search images'));
  assert.ok(isSerpBoilerplate('Privacy Policy](#) and Terms of Service'));
  assert.ok(isSerpBoilerplate('Open links in new tab for all search queries'));
  assert.ok(isSerpBoilerplate('https://www.bing.com/ck/a?params=xyz'));
  assert.strictEqual(isSerpBoilerplate('We are hiring AI automation engineers in Auckland'), false);
});

test('extractPostSnippets returns empty when no LinkedIn post results exist (no boilerplate fallback)', () => {
  const nonPostResults: any[] = [
    {
      title: 'Michaels Stores - Art Supplies',
      url: 'https://michaels.com',
      content: 'Find supplies and crafts.',
    },
    {
      title: 'Visual Search',
      url: 'https://bing.com/ck/a?123',
      content: 'Open links in new tab. Privacy Policy](#)',
    },
    {
      title: 'John Doe Profile | LinkedIn',
      url: 'https://www.linkedin.com/in/johndoe',
      content: 'Founder at AI Consultancy. Experienced in automation.',
    },
  ];

  const { snippets, postContext, firstUrl } = extractPostSnippets(nonPostResults);
  assert.deepStrictEqual(snippets, []);
  assert.strictEqual(postContext, '');
  assert.strictEqual(firstUrl, undefined);
});

test('extractPostSnippets extracts valid posts while filtering boilerplate in mixed list', () => {
  const mixedResults: any[] = [
    {
      title: 'Bing Navigation | Visual Search',
      url: 'https://www.linkedin.com/posts/fake_boilerplate',
      content: 'Open links in new tab',
    },
    {
      title: 'John Doe on LinkedIn',
      url: 'https://www.linkedin.com/posts/johndoe_automation-breakthrough',
      content: 'Excited to announce our new client automation system launched in Wellington.',
    },
    {
      title: 'John Doe Profile',
      url: 'https://www.linkedin.com/in/johndoe',
      content: 'Bio text that should be ignored.',
    },
    {
      title: 'Recent Activity',
      url: 'https://www.linkedin.com/in/johndoe/recent-activity/',
      content: 'We just onboarded 3 new enterprise AI clients this quarter.',
    },
  ];

  const { snippets, postContext, firstUrl } = extractPostSnippets(mixedResults);
  assert.strictEqual(snippets.length, 2);
  assert.ok(snippets[0].includes('Excited to announce our new client automation system'));
  assert.ok(snippets[1].includes('We just onboarded 3 new enterprise AI clients'));
  assert.strictEqual(firstUrl, 'https://www.linkedin.com/posts/johndoe_automation-breakthrough');
  assert.ok(postContext.includes('[Post snippet]:'));
});

test('extractPostSnippets handles empty input', () => {
  const { snippets, postContext, firstUrl } = extractPostSnippets([]);
  assert.deepStrictEqual(snippets, []);
  assert.strictEqual(postContext, '');
  assert.strictEqual(firstUrl, undefined);
});
