/**
 * Prospect Contract Corpus Regression Fixtures (remediation for the systemic
 * contract scope-inversion and cache-poisoning defect).
 *
 * The 33 briefs in test/fixtures/prospectContractCorpus.ts are the verbatim
 * briefs of every historical prospect_contract_cache row (policy v8-v10,
 * 2026-09-07 through 2026-10-16). Seven of those cached contracts carried
 * inverted, impossible requirements (e.g. person_location = ["outbound
 * pipeline"], company_type = ["Salt Lake City specializing"]). The deterministic
 * compiler must:
 *   - never re-emit any historical corrupt value,
 *   - keep every geo entity named in a brief inside person_location,
 *   - keep company_type a clean vertical (digit-free, place-free, tool-free
 *     unless org-qualified, junk-clause-free),
 *   - and the coherence validator must heal/drop inverted requirements.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  ALL_KNOWN_METROS,
  buildDeterministicProspectContract,
  PROSPECT_CONTRACT_POLICY_VERSION,
  TOOLING_SIGNAL_PHRASE_RE,
  ORG_NOUN_PHRASE_RE,
  validateAndHealContractCoherence,
  type ProspectContract,
  type ProspectRequirement,
} from '../server/leadSearch/prospectContract.js';
import { resolveCountryCode } from '../server/leadSearch/geo.js';
import {
  PROSPECT_CONTRACT_CORPUS,
  type ProspectContractCorpusCase,
} from './fixtures/prospectContractCorpus.js';

const US_STATE_NAMES_SRC =
  'alabama|alaska|arizona|arkansas|california|colorado|connecticut|delaware|florida|georgia|hawaii|idaho|illinois|indiana|iowa|kansas|kentucky|louisiana|maine|maryland|massachusetts|michigan|minnesota|mississippi|missouri|montana|nebraska|nevada|new hampshire|new jersey|new mexico|new york|north carolina|north dakota|ohio|oklahoma|oregon|pennsylvania|rhode island|south carolina|south dakota|tennessee|texas|utah|vermont|virginia|washington|west virginia|wisconsin|wyoming';

const METRO_RE_SRC = ALL_KNOWN_METROS.map((m) => m.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|');

const REGION_NAMES_SRC =
  'north america|south america|europe|asia|emea|apac|latam|mena|middle east|southeast asia|benelux|scandinavia|latin america|european union';

const isGeoTerm = (term: string): boolean => {
  const value = String(term || '').trim().toLowerCase();
  if (!value) return false;
  if (new RegExp(`\\b(?:${METRO_RE_SRC})\\b`, 'i').test(value)) return true;
  if (resolveCountryCode(value)) return true;
  if (new RegExp(`\\b(?:${US_STATE_NAMES_SRC})\\b`, 'i').test(value)) return true;
  if (new RegExp(`\\b(?:${REGION_NAMES_SRC})\\b`, 'i').test(value)) return true;
  return false;
};

const containsClauseJunk = (value: string): boolean => {
  return (
    /\bwho\s+(?:use|talk|need|want|require|adopt|care)\b/i.test(value) ||
    /\b(?:talk(?:ing)?\s+about|looking\s+(?:to|for)|interested\s+in)\b/i.test(value)
  );
};

const isDigitalLeading = (value: string): boolean => /^\d/.test(value.trim());

const cityPrefixes = new Set<string>();
for (const metro of ALL_KNOWN_METROS) {
  const words = metro.trim().split(/\s+/);
  for (let i = 1; i <= words.length; i++) {
    cityPrefixes.add(words.slice(0, i).join(' ').toLowerCase());
  }
}

const startsWithGeoName = (value: string): boolean => {
  const words = value.trim().toLowerCase().split(/\s+/);
  for (let i = Math.min(words.length, 3); i >= 1; i--) {
    const prefix = words.slice(0, i).join(' ');
    if (cityPrefixes.has(prefix)) return true;
    if (new RegExp(`^(?:${US_STATE_NAMES_SRC})\\b`).test(prefix)) return true;
    if (new RegExp(`^(?:${REGION_NAMES_SRC})\\b`, 'i').test(prefix)) return true;
    if (resolveCountryCode(prefix) && i <= 2) return true;
  }
  return false;
};

const isCorruptCompanyTypeTerm = (value: string): boolean => {
  const v = String(value || '').trim();
  if (!v) return true;
  if (isDigitalLeading(v)) return true;
  if (containsClauseJunk(v)) return true;
  if (TOOLING_SIGNAL_PHRASE_RE.test(v) && !ORG_NOUN_PHRASE_RE.test(v)) return true;
  if (startsWithGeoName(v) && !ORG_NOUN_PHRASE_RE.test(v)) return true;
  return false;
};

const locationReq = (contract: ProspectContract): ProspectRequirement | undefined =>
  contract.requirements.find((r) => r.scope === 'person_location');

const companyTypeReq = (contract: ProspectContract): ProspectRequirement | undefined =>
  contract.requirements.find((r) => r.scope === 'company_type');

const corruptValuesPresent = (contract: ProspectContract, kase: ProspectContractCorpusCase): string[] => {
  if (!kase.corruptSourcePhrases.length) return [];
  const haystacks = contract.requirements.flatMap((req) => [
    String(req.sourcePhrase || ''),
    ...(req.acceptableTerms || []),
    String(req.description || ''),
  ]);
  const lowerStack = haystacks.map((v) => v.toLowerCase());
  return kase.corruptSourcePhrases.filter((phrase) =>
    lowerStack.some((hay) => hay.includes(phrase.toLowerCase())),
  );
};

const missingGeoTokens = (contract: ProspectContract, kase: ProspectContractCorpusCase): string[] => {
  if (!kase.mustIncludeLocations?.length) return [];
  const loc = locationReq(contract);
  if (!loc) return [...kase.mustIncludeLocations];
  const haystack = (loc.acceptableTerms || []).join(' ; ').toLowerCase();
  return kase.mustIncludeLocations.filter((token) => {
    const needle = token.toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return !new RegExp(`(^|[^a-z0-9])${needle}([^a-z0-9]|$)`, 'i').test(haystack);
  });
};

describe('prospect contract corpus (33 historical briefs)', () => {
  for (const kase of PROSPECT_CONTRACT_CORPUS) {
    const label = `#${kase.id}: ${kase.brief.slice(0, 72)}${kase.brief.length > 72 ? '...' : ''}${kase.issues.length ? ` [${kase.issues.join(',')}]` : ''}`;
    it(label, () => {
      const contract = buildDeterministicProspectContract(kase.brief);

      // 1. No historical corrupt value may ever be emitted again.
      const corrupt = corruptValuesPresent(contract, kase);
      assert.deepEqual(
        corrupt,
        [],
        `historical corrupt value(s) re-emitted: ${JSON.stringify(corrupt)}`,
      );

      // 2. Every geo entity named in the brief must be capturable as a location.
      const missingGeo = missingGeoTokens(contract, kase);
      assert.deepEqual(
        missingGeo,
        [],
        `person_location missing brief geo "${missingGeo.join('","')}"; got: ${JSON.stringify(locationReq(contract)?.acceptableTerms || [])}`,
      );

      // 3. Location terms stay geo-anchored: no person_location term may be a
      //    pure tooling/junk value that the funnel grabbed instead of a place.
      const loc = locationReq(contract);
      if (loc) {
        const terms = (loc.acceptableTerms || []).filter(Boolean);
        if (terms.length) {
          const geoCount = terms.filter(isGeoTerm).length;
          assert.ok(
            geoCount >= Math.ceil(terms.length / 2),
            `person_location majority must be geo (got ${geoCount}/${terms.length}): ${JSON.stringify(terms)}`,
          );
          for (const term of terms) {
            assert.ok(
              !(TOOLING_SIGNAL_PHRASE_RE.test(term) && !ORG_NOUN_PHRASE_RE.test(term)),
              `person_location must not carry tooling term "${term}"`,
            );
          }
        }
      }

      // 4. Company type stays a clean vertical.
      const ct = companyTypeReq(contract);
      if (ct) {
        for (const term of [...(ct.acceptableTerms || []), ct.sourcePhrase]) {
          if (!term) continue;
          assert.ok(
            !isCorruptCompanyTypeTerm(term),
            `company_type term "${term}" fails coherence (digit/junk/tooling/geo-prefix)`,
          );
        }
      }

      // 5. Role terms are sane strings.
      const role = contract.requirements.find((r) => r.scope === 'person_role');
      if (role) {
        for (const term of role.acceptableTerms || []) {
          assert.ok(
            typeof term === 'string' && term.trim().length >= 2,
            `person_role carries degenerate term "${term}"`,
          );
        }
      }
    });
  }

  it('fixtures cover the known corrupted rowids', () => {
    const regressed = PROSPECT_CONTRACT_CORPUS.filter((c) => c.issues.length > 0).map((c) => c.id);
    assert.deepEqual(
      new Set(regressed),
      new Set([11, 16, 17, 31, 32, 33, 34]),
      'the regressed fixture set must match the forensic audit (7 cases)',
    );
  });

  it('policy version must advance past the poisoned v10 entries', () => {
    const version: string = PROSPECT_CONTRACT_POLICY_VERSION;
    assert.ok(
      version !== 'evidence-contract-v10',
      `policy version must not regress to v10 (got ${PROSPECT_CONTRACT_POLICY_VERSION})`,
    );
  });
});

describe('validateAndHealContractCoherence', () => {
  const BRIEF = 'Founders, CEOs, and Managing Partners of boutique B2B outbound and demand generation agencies with 4 to 20 employees in Austin, Denver, Toronto, and Salt Lake City specializing in outbound pipeline, Clay data enrichment, or cold email infrastructure';

  it('heals the exact historical rowid-33 hybrid (LLM identitySpec + inverted funnels)', () => {
    // Reproduction of the cached v10 contract: correct LLM-authored
    // identitySpec, deterministic funnels inverted into the requirements.
    const poisoned: ProspectContract = {
      version: 1,
      policyVersion: 'evidence-contract-v10',
      brief: BRIEF,
      decompositionMode: 'dual_stream_intent',
      identitySpec: {
        roles: ['Founder', 'Co-Founder', 'CEO', 'Managing Partner'],
        locations: ['Austin', 'Denver', 'Toronto', 'Salt Lake City'],
        companyTypes: ['B2B outbound agency', 'demand generation agency', 'boutique outbound agency'],
        industries: [],
      },
      authorityRequired: true,
      requirements: [
        {
          id: 'person_role-1',
          scope: 'person_role',
          importance: 'hard',
          evidenceModality: 'structured_profile',
          description: 'founder or ceo or managing partner',
          sourcePhrase: 'founder',
          acceptableTerms: ['founder', 'founders', 'ceo', 'ceos', 'owner', 'owners', 'firm owner', 'co-founder', 'cofounder', 'CEO', 'chief executive officer', 'managing partner', 'managing director', 'president', 'proprietor', 'agency owner'],
          queryable: true,
          groupId: 'person_role_group',
          matchRule: 'any_of',
          requirementClass: 'identity_hard',
          queryHardness: 'required_in_every_query',
          acceptableEvidenceSources: [],
        },
        {
          id: 'person_location-1',
          scope: 'person_location',
          importance: 'hard',
          evidenceModality: 'structured_profile',
          description: 'outbound pipeline',
          sourcePhrase: 'outbound pipeline',
          acceptableTerms: ['outbound pipeline', 'Clay data enrichment', 'cold email infrastructure'],
          queryable: true,
          requirementClass: 'context_hard',
          queryHardness: 'distributed_across_queries',
          acceptableEvidenceSources: [],
        },
        {
          id: 'company_type-1',
          scope: 'company_type',
          importance: 'hard',
          evidenceModality: 'structured_profile',
          description: 'Salt Lake City specializing',
          sourcePhrase: 'Salt Lake City specializing',
          acceptableTerms: ['Salt Lake City specializing'],
          queryable: true,
          requirementClass: 'context_hard',
          queryHardness: 'distributed_across_queries',
          acceptableEvidenceSources: [],
        },
      ],
      exclusions: [],
      initialQueries: [],
    };

    const result = validateAndHealContractCoherence(poisoned, BRIEF);
    assert.equal(result.valid, false, 'the poisoned contract must not pass coherence');
    assert.ok(result.warnings.length > 0, 'healing must surface warnings');

    const healedLoc = result.contract.requirements.find((r) => r.scope === 'person_location');
    assert.ok(healedLoc, 'person_location healed from identitySpec must exist');
    for (const city of ['austin', 'denver', 'toronto', 'salt lake city']) {
      assert.ok(
        healedLoc.acceptableTerms.some((t) => t.toLowerCase() === city),
        `person_location must contain "${city}", got: ${JSON.stringify(healedLoc.acceptableTerms)}`,
      );
    }
    assert.ok(
      !healedLoc.acceptableTerms.some((t) => TOOLING_SIGNAL_PHRASE_RE.test(t)),
      'person_location must not keep tooling terms',
    );

    const healedCt = result.contract.requirements.find((r) => r.scope === 'company_type');
    assert.ok(
      !healedCt || healedCt.acceptableTerms.some((t) => !isCorruptCompanyTypeTerm(t)),
      'company_type must be healed into a valid vertical or removed',
    );
    assert.ok(
      !result.contract.requirements.some(
        (r) => r.acceptableTerms.includes('Salt Lake City specializing') || r.sourcePhrase === 'Salt Lake City specializing',
      ),
      '"Salt Lake City specializing" must not survive anywhere in the healed contract',
    );
  });

  it('passes a healthy contract through unchanged', () => {
    const healthy = buildDeterministicProspectContract('AI marketing agency owner from the USA');
    const result = validateAndHealContractCoherence(healthy, healthy.brief);
    assert.equal(result.valid, true, `unexpected warnings: ${JSON.stringify(result.warnings)}`);
    assert.equal(result.warnings.length, 0);
    assert.equal(result.contract, healthy, 'unmodified contract must be returned as-is');
  });

  it('adds person_location from brief-grounded identitySpec when the compile emitted none', () => {
    // Plan item: person_location "empty" is also corrupted - an LLM compile that
    // emits correct identitySpec.locations but no requirement at all would leave
    // the session without a location gate.
    const brief = 'agency founders in Austin or Denver';
    const missing: ProspectContract = {
      version: 1,
      policyVersion: PROSPECT_CONTRACT_POLICY_VERSION,
      brief,
      identitySpec: { roles: ['Founder'], locations: ['Austin', 'Denver'], companyTypes: [], industries: [] },
      authorityRequired: true,
      requirements: [
        {
          id: 'person_role-1',
          scope: 'person_role',
          importance: 'hard',
          evidenceModality: 'structured_profile',
          description: 'agency founder',
          sourcePhrase: 'agency founder',
          acceptableTerms: ['agency founder', 'founder'],
          queryable: true,
          groupId: 'person_role_group',
          matchRule: 'any_of',
          requirementClass: 'identity_hard',
          queryHardness: 'required_in_every_query',
          acceptableEvidenceSources: [],
        },
      ],
      exclusions: [],
      initialQueries: [],
    };
    const result = validateAndHealContractCoherence(missing, brief);
    assert.equal(result.valid, false, 'the heal must surface a warning');
    const added = result.contract.requirements.find((r) => r.scope === 'person_location');
    assert.ok(added, 'person_location must be added from identitySpec.locations');
    assert.equal(added.importance, 'hard');
    assert.deepEqual(added.acceptableTerms, ['Austin', 'Denver']);
    assert.equal(added.provenance, 'llm_compiled');
    assert.ok(
      result.warnings.some((w) => w.includes('added person_location')),
      `expected add-warning, got: ${JSON.stringify(result.warnings)}`,
    );
  });

  it('drops an impossible location requirement with no heir', () => {
    const impossible: ProspectContract = {
      version: 1,
      policyVersion: PROSPECT_CONTRACT_POLICY_VERSION,
      brief: 'B2B data enrichment industry',
      identitySpec: { roles: [], locations: [], companyTypes: [], industries: [] },
      authorityRequired: true,
      requirements: [
        {
          id: 'person_location-1',
          scope: 'person_location',
          importance: 'hard',
          evidenceModality: 'structured_profile',
          description: 'self-hosting n8n',
          sourcePhrase: 'self-hosting n8n',
          acceptableTerms: ['self-hosting n8n'],
          queryable: true,
          requirementClass: 'context_hard',
          queryHardness: 'distributed_across_queries',
          acceptableEvidenceSources: [],
        },
      ],
      exclusions: [],
      initialQueries: [],
    };
    const result = validateAndHealContractCoherence(impossible, impossible.brief);
    assert.equal(result.valid, false);
    assert.equal(
      result.contract.requirements.some((r) => r.scope === 'person_location'),
      false,
      'impossible location requirement must be dropped',
    );
  });
});
