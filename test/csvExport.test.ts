import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import Papa from 'papaparse';
import type { Lead } from '../src/types.ts';
import {
  extractCleanDomain,
  extractIcebreakerQuote,
  getLeadPriorityTier,
  sanitizeFormulaInjection,
  formatCsvCell,
  serializeLeadsToCsv,
  serializeLeadsToTsv,
} from '../src/utils/csvExport.ts';
import {
  createCsvFieldReader,
  CSV_FIELD_ALIASES,
} from '../src/utils/csvFieldMapping.ts';

const createMockLead = (overrides: Partial<Lead> = {}): Lead => {
  return {
    id: 'lead-test-123',
    revision: 1,
    profile: {
      id: 'profile-test-123',
      fullName: 'Hao Li',
      headline: 'CEO & Co-Founder of Pinscreen',
      currentCompany: 'Pinscreen',
      currentTitle: 'CEO & Co-Founder',
      seniorityLevel: 'Founder-Owner',
      location: 'Los Angeles, California, United States',
      industry: 'Artificial Intelligence',
      skills: ['Generative AI', 'Computer Vision'],
      contactDetails: {
        email: 'hao@pinscreen.com',
        phone: '+1-555-0199',
        linkedinUrl: 'https://linkedin.com/in/lihao',
        website: 'https://www.pinscreen.com',
      },
      summary: 'Pioneering generative AI technologies in visual effects and digital humans.',
    },
    stage: 'SEQUENCE ACTIVE',
    reviewStatus: 'KEEP',
    nextAction: 'MESSAGE',
    tier: 'TIER 1: PRIORITY',
    compositeScore: 95,
    fitScore: 9.5,
    intentScore: 9.2,
    timingScore: 8.8,
    icpScoreReasoning: 'Verified founder with active hiring triggers in AI.',
    notes: 'Key prospect in Q4 sequence.',
    tags: ['AI_FOUNDER', 'USA', 'SERIES_A'],
    createdAt: '2026-10-23T16:39:52.479Z',
    hiringSignalUrl: 'https://linkedin.com/posts/lihao-hiring-123',
    postIntentEvidence: {
      queriedAt: '2026-10-23T16:40:00Z',
      intentCategory: 'hiring',
      quality: 'strong',
      confidenceScore: 0.94,
      intentKeywords: ['hiring', 'cracked engineers'],
      postSnippets: ['Looking for cracked engineers to work directly with me.'],
      llmReason: 'Explicit hiring post for technical talent.',
    },
    ...overrides,
  };
};

describe('CSV Export Engine (src/utils/csvExport.ts)', () => {
  describe('Domain & Entity Extraction', () => {
    it('normalizes various URL formats into clean bare domains', () => {
      const lead1 = createMockLead();
      assert.equal(extractCleanDomain(lead1), 'pinscreen.com');

      const lead2 = createMockLead({
        profile: {
          ...createMockLead().profile,
          contactDetails: { website: 'http://subdomain.acme.co.uk/path?ref=123' },
        },
      });
      assert.equal(extractCleanDomain(lead2), 'subdomain.acme.co.uk');

      const lead3 = createMockLead({
        profile: {
          ...createMockLead().profile,
          contactDetails: { website: 'www.hyper-growth.ai/' },
        },
      });
      assert.equal(extractCleanDomain(lead3), 'hyper-growth.ai');

      const leadWithAttribution = {
        ...createMockLead(),
        companyAttribution: {
          companyDomain: 'https://www.studio.com/team',
        },
      } as any;
      assert.equal(extractCleanDomain(leadWithAttribution), 'studio.com');
    });

    it('returns empty string when no domain or website exists', () => {
      const lead = createMockLead({
        profile: {
          ...createMockLead().profile,
          contactDetails: {},
        },
      });
      assert.equal(extractCleanDomain(lead), '');
    });
  });

  describe('Verbatim Icebreaker Quote Extraction', () => {
    it('extracts verbatim quotes from company attribution first', () => {
      const lead = {
        ...createMockLead(),
        companyAttribution: {
          verbatimEvidenceQuote: 'Pinscreen is renowned for pioneering visual effects.',
        },
      } as any;
      assert.equal(
        extractIcebreakerQuote(lead),
        'Pinscreen is renowned for pioneering visual effects.',
      );
    });

    it('falls back to qualification requirement evidence quote', () => {
      const lead = {
        ...createMockLead(),
        qualification: {
          requirements: [
            { requirementId: 'role', evidenceQuote: 'Hao Li is the CEO & Co-Founder' },
          ],
        },
      } as any;
      assert.equal(extractIcebreakerQuote(lead), 'Hao Li is the CEO & Co-Founder');
    });

    it('falls back to post intent snippet when attribution is absent', () => {
      const lead = createMockLead();
      assert.equal(
        extractIcebreakerQuote(lead),
        'Looking for cracked engineers to work directly with me.',
      );
    });
  });

  describe('Priority Tier Calculation', () => {
    it('preserves explicit tier when present', () => {
      const lead = createMockLead({ tier: 'TIER 1: PRIORITY' });
      assert.equal(getLeadPriorityTier(lead), 'TIER 1: PRIORITY');
    });

    it('derives tier from composite score when tier is omitted', () => {
      const lead1 = createMockLead({ tier: undefined, compositeScore: 88 });
      assert.equal(getLeadPriorityTier(lead1), 'TIER 1: PRIORITY');

      const lead2 = createMockLead({ tier: undefined, compositeScore: 65 });
      assert.equal(getLeadPriorityTier(lead2), 'TIER 2: ACTIVE');

      const lead3 = createMockLead({ tier: undefined, compositeScore: 45 });
      assert.equal(getLeadPriorityTier(lead3), 'TIER 3: WATCH');

      const lead4 = createMockLead({ tier: undefined, compositeScore: 20 });
      assert.equal(getLeadPriorityTier(lead4), 'TIER 4: DEPRIORITIZE');
    });
  });

  describe('Formula Injection & RFC 4180 Escaping', () => {
    it('neutralizes dangerous formula injection characters with leading single quote', () => {
      assert.equal(sanitizeFormulaInjection('=1+2'), "'=1+2");
      assert.equal(sanitizeFormulaInjection('+cmd|'), "'+cmd|");
      assert.equal(sanitizeFormulaInjection('-DDE("calc")'), "'-DDE(\"calc\")");
      assert.equal(sanitizeFormulaInjection('@SUM(A1:A10)'), "'@SUM(A1:A10)");
      assert.equal(sanitizeFormulaInjection('\tmalicious'), "'\tmalicious");
      assert.equal(sanitizeFormulaInjection('Safe string'), 'Safe string');
    });

    it('escapes quotes and wraps cells in double quotes', () => {
      assert.equal(formatCsvCell('Normal text'), '"Normal text"');
      assert.equal(formatCsvCell('He said "Hello"'), '"He said ""Hello"""');
      assert.equal(formatCsvCell('=HYPERLINK("http://evil.com")'), '"\'=HYPERLINK(""http://evil.com"")"');
      assert.equal(formatCsvCell(null), '""');
      assert.equal(formatCsvCell(undefined), '""');
    });
  });

  describe('Preset Serialization & Round-Trip', () => {
    it('serializes Outreach preset with required outbound fields', () => {
      const lead = createMockLead();
      const csv = serializeLeadsToCsv([lead], 'outreach');
      const lines = csv.split('\n');

      assert.equal(lines.length, 2);
      const headers = lines[0];

      assert.ok(headers.includes('"First Name"'));
      assert.ok(headers.includes('"Last Name"'));
      assert.ok(headers.includes('"Current Company"'));
      assert.ok(headers.includes('"Company Domain"'));
      assert.ok(headers.includes('"Priority Tier"'));
      assert.ok(headers.includes('"Personalized Icebreaker Quote"'));
      assert.ok(headers.includes('"Signal Evidence URL"'));

      const row = lines[1];
      assert.ok(row.includes('"Hao"'));
      assert.ok(row.includes('"Li"'));
      assert.ok(row.includes('"pinscreen.com"'));
      assert.ok(row.includes('"TIER 1: PRIORITY"'));
      assert.ok(row.includes('"Looking for cracked engineers to work directly with me."'));
    });

    it('serializes CRM preset with firmographics, scores, and tags', () => {
      const lead = createMockLead();
      const csv = serializeLeadsToCsv([lead], 'crm');
      const lines = csv.split('\n');

      assert.equal(lines.length, 2);
      const headers = lines[0];

      assert.ok(headers.includes('"Company Domain"'));
      assert.ok(headers.includes('"ICP Fit Score"'));
      assert.ok(headers.includes('"Workflow Tags"'));
      assert.ok(headers.includes('"ICP Fit Rationale"'));

      const row = lines[1];
      assert.ok(row.includes('"AI_FOUNDER; USA; SERIES_A"'));
      assert.ok(row.includes('"Verified founder with active hiring triggers in AI."'));
    });

    it('serializes Full Diagnostic dump with all criteria and intervals', () => {
      const lead = createMockLead({
        scoreBreakdown: {
          fitScore: 9,
          intentScore: 9,
          timingScore: 8,
          evidenceQualityScore: 9,
          sourceConfidenceScore: 8,
          finalScore: 9.2,
          confidenceInterval: {
            lower: 8.5,
            upper: 9.8,
            uncertainty: 0.65,
          },
        },
      });
      const csv = serializeLeadsToCsv([lead], 'diagnostic');
      const lines = csv.split('\n');

      assert.equal(lines.length, 2);
      assert.ok(lines[0].includes('"95% Credible Interval"'));
      assert.ok(lines[1].includes('"[8.5 - 9.8]"'));
    });

    it('round-trips Outreach preset CSV through CSV_FIELD_ALIASES successfully', () => {
      const lead = createMockLead();
      const csv = serializeLeadsToCsv([lead], 'outreach');
      const parsed = Papa.parse(csv, { header: true, skipEmptyLines: true });
      const rows = parsed.data as Record<string, string>[];

      assert.equal(rows.length, 1);
      const row = rows[0];

      const getField = createCsvFieldReader(row);
      assert.equal(getField(CSV_FIELD_ALIASES.firstName), 'Hao');
      assert.equal(getField(CSV_FIELD_ALIASES.lastName), 'Li');
      assert.equal(getField(CSV_FIELD_ALIASES.fullName), 'Hao Li');
      assert.equal(getField(CSV_FIELD_ALIASES.company), 'Pinscreen');
      assert.equal(getField(CSV_FIELD_ALIASES.title), 'CEO & Co-Founder');
      assert.equal(getField(CSV_FIELD_ALIASES.domain), 'pinscreen.com');
      assert.equal(getField(CSV_FIELD_ALIASES.tier), 'TIER 1: PRIORITY');
      assert.equal(getField(CSV_FIELD_ALIASES.icebreaker), 'Looking for cracked engineers to work directly with me.');
      assert.equal(getField(CSV_FIELD_ALIASES.hiringUrl), 'https://linkedin.com/posts/lihao-hiring-123');
    });

    it('serializes to TSV for clipboard copy', () => {
      const lead = createMockLead();
      const tsv = serializeLeadsToTsv([lead], 'outreach');
      const lines = tsv.split('\n');
      assert.equal(lines.length, 2);
      const rowCols = lines[1].split('\t');
      assert.ok(rowCols.length > 10);
      assert.equal(rowCols[0], 'Hao');
      assert.equal(rowCols[1], 'Li');
    });
  });
});
