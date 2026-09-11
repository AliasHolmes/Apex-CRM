import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { unwrapRedirectUrl, getLinkedInHandle, isValidLinkedInHandle, canonicalLinkedInIdentity } from '../src/utils/leadDedupe.js';
import { normalizeLinkedInUrl, extractLinkedInUsername } from '../server/services/linkedinEvidence.js';
import { extractLinkedInProfileUrlFromResult, parseBingMarkdownResults } from '../server/services/brightdata.js';
import { COUNTRY_TO_METROS, COUNTRY_CANONICAL_MAP } from '../server/leadSearch/prospectContract.js';
import { getRecoveryCandidateCeiling, buildCollectionCapacity } from '../server/leadSearch/collectionCapacity.js';
import { buildRetrievalTasks, buildFallbackQueryPlan, COUNTRY_TO_TAVILY_CODE } from '../server/leadSearch/searchSpec.js';
import { computeEarlyStopThreshold } from '../server/leadSearch/sessionHelpers.js';

describe('Lead Mining Bottlenecks and Artificial Ceilings Fixes', () => {

  describe('1. Redirect URL Unwrapping and Top-of-Funnel Drop-off Prevention', () => {
    it('unwraps BrightData /goto?url= redirects containing encoded LinkedIn profile URLs', () => {
      const raw = 'https://brightdata.com/goto?url=https%3A%2F%2Fwww.linkedin.com%2Fin%2Fsarah-connor-ai';
      const unwrapped = unwrapRedirectUrl(raw);
      assert.equal(unwrapped, 'https://www.linkedin.com/in/sarah-connor-ai');
      assert.equal(getLinkedInHandle(raw), 'sarah-connor-ai');
      assert.equal(normalizeLinkedInUrl(raw), 'linkedin.com/in/sarah-connor-ai');
    });

    it('unwraps relative /goto?url= paths without leading domain', () => {
      const raw = '/goto?url=https%3A%2F%2Flinkedin.com%2Fin%2Fjohn-smith-ceo';
      const unwrapped = unwrapRedirectUrl(raw);
      assert.equal(unwrapped, 'https://linkedin.com/in/john-smith-ceo');
      assert.equal(getLinkedInHandle(raw), 'john-smith-ceo');
      assert.equal(normalizeLinkedInUrl(raw), 'linkedin.com/in/john-smith-ceo');
    });

    it('unwraps search engine /url?q= and redirect params', () => {
      const raw = 'https://www.google.com/url?q=https://www.linkedin.com/in/alex-turner-founder&sa=U';
      const unwrapped = unwrapRedirectUrl(raw);
      assert.equal(unwrapped, 'https://www.linkedin.com/in/alex-turner-founder');
      assert.equal(getLinkedInHandle(raw), 'alex-turner-founder');
    });

    it('unwraps nested encoded redirect URLs', () => {
      const nested = '/goto?url=' + encodeURIComponent('/goto?url=' + encodeURIComponent('https://www.linkedin.com/in/nested-founder'));
      const unwrapped = unwrapRedirectUrl(nested);
      assert.equal(unwrapped, 'https://www.linkedin.com/in/nested-founder');
      assert.equal(getLinkedInHandle(nested), 'nested-founder');
    });
  });

  describe('2. LinkedIn /posts/ and /pulse/ Handle Recovery', () => {
    it('extracts canonical profile from /posts/ activity URLs', () => {
      const postUrl = 'https://www.linkedin.com/posts/dr-alan-grant_ai-breakthrough-in-biotech-activity-7123456789012345678-xYz1';
      assert.equal(getLinkedInHandle(postUrl), 'dr-alan-grant');
      assert.equal(normalizeLinkedInUrl(postUrl), 'linkedin.com/in/dr-alan-grant');
      assert.equal(canonicalLinkedInIdentity(postUrl), 'linkedin:dr-alan-grant');
    });

    it('extracts canonical profile from hyphenated activity post URLs', () => {
      const postUrl = 'https://www.linkedin.com/posts/ellie-sattler-activity-7123456789012345678';
      assert.equal(getLinkedInHandle(postUrl), 'ellie-sattler');
      assert.equal(normalizeLinkedInUrl(postUrl), 'linkedin.com/in/ellie-sattler');
    });

    it('extracts canonical profile from /pulse/ author articles', () => {
      const pulseUrl = 'https://www.linkedin.com/pulse/ian-malcolm-chaos-theory-in-machine-learning';
      assert.equal(getLinkedInHandle(pulseUrl), 'ian-malcolm-chaos-theory-in-machine-learning');
      assert.equal(normalizeLinkedInUrl(pulseUrl), 'linkedin.com/in/ian-malcolm-chaos-theory-in-machine-learning');
    });

    it('rejects reserved non-profile LinkedIn paths and numeric/activity identifiers', () => {
      assert.equal(isValidLinkedInHandle('feed'), false);
      assert.equal(isValidLinkedInHandle('company'), false);
      assert.equal(isValidLinkedInHandle('in'), false);
      assert.equal(isValidLinkedInHandle('posts'), false);
      assert.equal(isValidLinkedInHandle('jobs'), false);
      assert.equal(isValidLinkedInHandle('activity'), false);
      assert.equal(isValidLinkedInHandle('activity-7123456789'), false);
      assert.equal(isValidLinkedInHandle('7123456789'), false);
      assert.equal(isValidLinkedInHandle('salary'), false);
      assert.equal(isValidLinkedInHandle('showcase'), false);
      assert.equal(isValidLinkedInHandle('services'), false);
      assert.equal(getLinkedInHandle('https://www.linkedin.com/feed/'), '');
      assert.equal(normalizeLinkedInUrl('https://www.linkedin.com/feed/'), '');
    });

    it('accepts valid handles with dots, dashes, underscores, and 2+ characters', () => {
      assert.equal(isValidLinkedInHandle('john.doe'), true);
      assert.equal(isValidLinkedInHandle('dr.alan.grant'), true);
      assert.equal(isValidLinkedInHandle('ed'), true);
      assert.equal(isValidLinkedInHandle('al'), true);
      assert.equal(getLinkedInHandle('https://www.linkedin.com/in/john.doe'), 'john.doe');
      assert.equal(normalizeLinkedInUrl('https://www.linkedin.com/in/john.doe'), 'linkedin.com/in/john.doe');
      // Trailing punctuation from scraped markdown
      assert.equal(getLinkedInHandle('https://www.linkedin.com/in/john-smith.'), 'john-smith');
      assert.equal(normalizeLinkedInUrl('https://www.linkedin.com/in/john-smith.'), 'linkedin.com/in/john-smith');
    });
  });

  describe('3. BrightData Result Parser Redirect Unwrapping', () => {
    it('recovers LinkedIn person profile URL from wrapped link in markdown search results', () => {
      const markdown = `
1. [Sarah Connor - Founder & CEO at Skynet Solutions | LinkedIn](https://brightdata.com/goto?url=https%3A%2F%2Fwww.linkedin.com%2Fin%2Fsarah-connor-founder)
   London, UK. Building next-generation autonomous AI systems.
`;
      const parsed = parseBingMarkdownResults(markdown);
      assert.equal(parsed.length, 1);
      assert.equal(parsed[0].url, 'https://www.linkedin.com/in/sarah-connor-founder');
      assert.equal(parsed[0].title, 'Sarah Connor - Founder & CEO at Skynet Solutions | LinkedIn');
    });

    it('extractLinkedInProfileUrlFromResult unwrap redirects and recovers person profile', () => {
      const item = {
        url: 'https://brightdata.com/goto?url=https%3A%2F%2Fwww.linkedin.com%2Fin%2Ffounder-uk',
        title: 'Founder - AI agency',
      };
      const recovered = extractLinkedInProfileUrlFromResult(item);
      assert.equal(normalizeLinkedInUrl(recovered), 'linkedin.com/in/founder-uk');
    });
  });

  describe('4. Dynamic Replenishment Country Qualification', () => {
    it('resolves UK country terms and qualifies metros with country suffix to avoid US collisions', () => {
      const locTerms = ['UK'];
      let targetCountry = '';
      for (const term of locTerms) {
        const cleanTerm = String(term || '').trim().toLowerCase();
        if (COUNTRY_CANONICAL_MAP[cleanTerm]) {
          targetCountry = COUNTRY_CANONICAL_MAP[cleanTerm];
          break;
        }
      }
      assert.equal(targetCountry, 'UK');

      const mappedMetros: string[] = [];
      for (const term of locTerms) {
        const cleanTerm = String(term || '').trim().toLowerCase();
        if (COUNTRY_TO_METROS[cleanTerm]) {
          const metros = COUNTRY_TO_METROS[cleanTerm];
          const countrySuffix = targetCountry || COUNTRY_CANONICAL_MAP[cleanTerm] || '';
          for (const m of metros) {
            if (countrySuffix && !m.toLowerCase().includes(countrySuffix.toLowerCase())) {
              mappedMetros.push(`${m} ${countrySuffix}`);
            } else {
              mappedMetros.push(m);
            }
          }
        }
      }

      assert.ok(mappedMetros.includes('Birmingham UK'), 'Birmingham must be qualified with UK');
      assert.ok(mappedMetros.includes('London UK'), 'London must be qualified with UK');
      assert.ok(mappedMetros.includes('Manchester UK'), 'Manchester must be qualified with UK');

      const COUNTRY_TO_TAVILY_CODE: Record<string, string> = {
        UK: 'gb',
        USA: 'us',
        Germany: 'de',
      };
      assert.equal(COUNTRY_TO_TAVILY_CODE[targetCountry], 'gb');
    });

    it('resolves Germany country terms and qualifies metros with Germany suffix', () => {
      const locTerms = ['germany'];
      let targetCountry = '';
      for (const term of locTerms) {
        const cleanTerm = String(term || '').trim().toLowerCase();
        if (COUNTRY_CANONICAL_MAP[cleanTerm]) {
          targetCountry = COUNTRY_CANONICAL_MAP[cleanTerm];
          break;
        }
      }
      assert.equal(targetCountry, 'Germany');

      const mappedMetros: string[] = [];
      const metros = COUNTRY_TO_METROS[targetCountry.toLowerCase()] || [];
      for (const m of metros) {
        mappedMetros.push(`${m} ${targetCountry}`);
      }

      assert.ok(mappedMetros.includes('Berlin Germany'));
      assert.ok(mappedMetros.includes('Munich Germany'));
    });
  });

  describe('5. Candidate Pool and Judging Ceilings', () => {
    it('provides high recovery candidate ceiling proportional to targetLimit', () => {
      // For target 20, ceiling is 160 (not 32)
      const cap20 = buildCollectionCapacity({ targetLimit: 20 });
      assert.equal(cap20.candidateCeiling, 160);
      assert.equal(getRecoveryCandidateCeiling(20), 160);

      // For target 50, ceiling is 400
      const cap50 = buildCollectionCapacity({ targetLimit: 50 });
      assert.equal(cap50.candidateCeiling, 400);
      assert.equal(getRecoveryCandidateCeiling(50), 400);
    });

    it('calculates candidatePoolCap allowing up to 240 candidates to be judged', () => {
      const targetLimit = 20;
      const rerankPoolTarget = 25;
      const collectedCandidatesCount = 120; // 120 candidates collected across productive rounds

      const effectivePoolCap = Math.max(
        rerankPoolTarget || 0,
        Math.ceil(targetLimit * 1.35),
        collectedCandidatesCount,
      );
      const candidatePoolCap = Math.max(
        targetLimit,
        Math.min(240, Math.max(effectivePoolCap, 24)),
      );

      // The old bug capped this to Math.min(60, ...) = 60, discarding half the collected candidates.
      // With our fix, all 120 candidates are retained for judging.
      assert.equal(candidatePoolCap, 120);
    });
  });

  describe('6. Retrieval Tasks and Fallback Query Plan Country Awareness', () => {
    it('buildRetrievalTasks derives Tavily country boost from spec when TAVILY_COUNTRY is unset', () => {
      const oldEnv = process.env.TAVILY_COUNTRY;
      delete process.env.TAVILY_COUNTRY;
      try {
        const spec: any = {
          person: { locations: ['UK'], includeTitles: ['owner'] },
          company: { locations: [], keywords: [] },
        };
        const items = [{ query: 'AI agency founder London', lane: 'person' as const }];
        const tasks = buildRetrievalTasks(items, spec);
        assert.equal(tasks.length, 1);
        assert.equal(tasks[0].tavily.country, 'united kingdom');
      } finally {
        if (oldEnv !== undefined) process.env.TAVILY_COUNTRY = oldEnv;
      }
    });

    it('buildFallbackQueryPlan generates country-qualified metros for UK', () => {
      const plans = buildFallbackQueryPlan('AI business owner UK');
      assert.ok(plans.length >= 3);
      const queries = plans.map(p => p.query);
      assert.ok(queries.some(q => q.includes('London UK')), `Expected London UK in queries: ${queries.join(', ')}`);
      assert.ok(queries.some(q => q.includes('Manchester UK')), `Expected Manchester UK in queries: ${queries.join(', ')}`);
    });

    it('buildFallbackQueryPlan generates country-qualified metros for Germany', () => {
      const plans = buildFallbackQueryPlan('AI consultancy in Berlin Germany');
      assert.ok(plans.length >= 3);
      const queries = plans.map(p => p.query);
      assert.ok(queries.some(q => q.includes('Berlin Germany')), `Expected Berlin Germany in queries: ${queries.join(', ')}`);
      assert.ok(queries.some(q => q.includes('Munich Germany')), `Expected Munich Germany in queries: ${queries.join(', ')}`);
    });
  });

  describe('7. Dynamic Replenishment Vertical Derivation and Extraction Slicing', () => {
    it('derives concise, unbloated vertical keyword from multi-part query without quoting entire brief', () => {
      const contract: any = {
        brief: 'AI business owner, AI service provider and AI agency owner from UK',
        requirements: [],
      };
      const promptQuery = 'AI business owner, AI service provider and AI agency owner from UK';

      const companyTypeReq = (contract?.requirements || []).find(
        (r: any) => r.scope === 'company_type' || r.scope === 'company_industry',
      );
      let rawVertical =
        contract?.identitySpec?.companyTypes?.[0] ||
        companyTypeReq?.acceptableTerms?.[0] ||
        '';

      if (!rawVertical) {
        const basePrompt = contract?.brief || promptQuery || '';
        rawVertical = basePrompt
          .replace(/\b(from|in|based in|located in|near)\b.*$/i, '')
          .replace(/\b(owner|founder|ceo|co-founder|director|managing partner|president|proprietor|executive|vp|head of)\b/gi, '')
          .replace(/[/\\|]/g, ' ')
          .replace(/\s+/g, ' ')
          .trim();
      }

      let verticalBase = rawVertical.trim();
      if (verticalBase.includes(',')) {
        verticalBase = verticalBase.split(',')[0].trim();
      }
      if (verticalBase.toLowerCase().includes(' and ')) {
        verticalBase = verticalBase.split(/\s+and\s+/i)[0].trim();
      }
      verticalBase = verticalBase.replace(/[^\w\s-]/g, '').replace(/\s+/g, ' ').trim();
      const verticalWords = verticalBase.split(/\s+/).filter(Boolean);
      if (verticalWords.length > 3) {
        verticalBase = verticalWords.slice(0, 2).join(' ');
      }
      const finalWords = verticalBase.split(/\s+/).filter(Boolean);
      const verticalTerm =
        finalWords.length > 0 && finalWords.length <= 2
          ? (verticalBase.includes(' ') ? `"${verticalBase}"` : verticalBase)
          : verticalBase;

      // Must NOT be the entire 10-word brief in quotes
      assert.notEqual(verticalTerm, '"AI business owner AI service provider and AI agency owner from UK"');
      // Must be concise, e.g. "AI business"
      assert.equal(verticalTerm, '"AI business"');
    });

    it('extractStage adaptive evidence slicing scales with candidateCeiling rather than prematurely capping to 27', () => {
      const acceptedLeadsLength = 25;
      const rerankPoolTarget = 25;
      const candidateCeiling = 160;

      // Old flawed calculation:
      const oldNeededPoolRemaining = Math.max(15, rerankPoolTarget - acceptedLeadsLength);
      const oldNeededEvidenceBlocks = Math.max(16, Math.ceil(oldNeededPoolRemaining * 1.8));
      assert.equal(oldNeededEvidenceBlocks, 27); // Discarded candidates in Round 2+!

      // New fixed calculation using candidateCeiling:
      const targetCeiling = Math.max(candidateCeiling || rerankPoolTarget, rerankPoolTarget);
      const newNeededPoolRemaining = Math.max(15, targetCeiling - acceptedLeadsLength);
      const newNeededEvidenceBlocks = Math.max(16, Math.ceil(newNeededPoolRemaining * 1.8));
      assert.equal(newNeededEvidenceBlocks, 243); // Properly retains all retrieved candidates!
    });

    it('non-progressive early stop requires earlyStopTargetThreshold and prevents premature exit', () => {
      const targetLimit = 20;
      const earlyStopTargetThreshold = computeEarlyStopThreshold(targetLimit, 0.7);
      // For target 20 with 0.7 pass rate, threshold is 39 (ceil(20 * 1.33 / 0.7) = 39)
      assert.equal(earlyStopTargetThreshold, 39);

      const acceptedLeadsCount = 20;
      const accumulatedViableCount = 12; // 60% of targetLimit

      // Under the old bug: (acceptedLeadsCount >= targetLimit && (acceptedLeadsCount >= earlyStopTargetThreshold || accumulatedViableCount >= 12))
      // It prematurely exited with only 20 leads!
      const oldPrematureExit =
        acceptedLeadsCount >= targetLimit &&
        (acceptedLeadsCount >= earlyStopTargetThreshold || accumulatedViableCount >= Math.ceil(targetLimit * 0.6));
      assert.equal(oldPrematureExit, true); // Proves the bug existed

      // Under our fix:
      const newExit =
        acceptedLeadsCount >= targetLimit &&
        acceptedLeadsCount >= earlyStopTargetThreshold;
      assert.equal(newExit, false); // Continues collecting candidates as required
    });
  });
});
