import test from 'node:test';
import assert from 'node:assert/strict';
import {
  COUNTRY_TO_METROS,
  AMBIGUOUS_METRO_NAMES,
  metroWithCountry,
  buildDeterministicProspectContract,
} from '../server/leadSearch/prospectContract.js';
import { resolveGeo } from '../server/leadSearch/queryUnderstanding.js';
import { buildStrategistPrompt, buildFallbackQueryPlan } from '../server/leadSearch/searchSpec.js';

test('NZ metros in COUNTRY_TO_METROS include all expanded regional hubs', () => {
  const nzMetros = COUNTRY_TO_METROS['new zealand'];
  assert.ok(Array.isArray(nzMetros));
  const expected = [
    'Auckland',
    'Wellington',
    'Christchurch',
    'Tauranga',
    'Hamilton',
    'Dunedin',
    'Palmerston North',
    'Nelson',
    'Queenstown',
  ];
  for (const city of expected) {
    assert.ok(nzMetros.includes(city), `Missing NZ metro: ${city}`);
  }
});

test('Other international markets in COUNTRY_TO_METROS remain unchanged', () => {
  assert.deepEqual(COUNTRY_TO_METROS['germany'], ['Berlin', 'Munich', 'Frankfurt', 'Hamburg', 'Cologne', 'Stuttgart']);
  assert.deepEqual(COUNTRY_TO_METROS['france'], ['Paris', 'Lyon', 'Marseille', 'Toulouse', 'Bordeaux']);
  assert.deepEqual(COUNTRY_TO_METROS['netherlands'], ['Amsterdam', 'Rotterdam', 'Utrecht', 'Eindhoven']);
  assert.deepEqual(COUNTRY_TO_METROS['ireland'], ['Dublin', 'Cork', 'Galway']);
});

test('Ambiguity guard: ambiguous metro names alone do not reverse-infer country', () => {
  assert.ok(AMBIGUOUS_METRO_NAMES.has('hamilton'));
  assert.ok(AMBIGUOUS_METRO_NAMES.has('nelson'));

  // "CEOs in Hamilton" without country cue should NOT anchor to NZ or Canada
  const geoHamilton = resolveGeo('CEOs in Hamilton');
  assert.equal(geoHamilton.countryAnchor, null);
  assert.equal(geoHamilton.geo, 'open_global');

  // "CEOs in Hamilton New Zealand" explicitly provides country anchor
  const geoHamiltonNZ = resolveGeo('CEOs in Hamilton New Zealand');
  assert.equal(geoHamiltonNZ.countryAnchor, 'New Zealand');

  // Unambiguous city "Auckland" does reverse-infer New Zealand
  const fallbackAuckland = buildFallbackQueryPlan('CEOs in Auckland');
  assert.ok(fallbackAuckland.some((p) => p.query.includes('Auckland')));
  assert.ok(fallbackAuckland.some((p) => p.query.includes('New Zealand')));
});

test('metroWithCountry attaches canonical country without duplicating', () => {
  assert.equal(metroWithCountry('Auckland', 'New Zealand'), 'Auckland New Zealand');
  assert.equal(metroWithCountry('Auckland New Zealand', 'New Zealand'), 'Auckland New Zealand');
  assert.equal(metroWithCountry('Paris', 'France'), 'Paris France');
  assert.equal(metroWithCountry('Tokyo', null), 'Tokyo');
});

test('buildStrategistPrompt recommends only NZ metros for NZ brief, and none for open_global', () => {
  const nzContract = buildDeterministicProspectContract('AI consultancies in New Zealand');
  const nzPrompt = buildStrategistPrompt({
    query: 'AI consultancies in New Zealand',
    contract: nzContract,
    round: 2,
    remaining: 10,
    previousQueries: ['founder AI consultancy New Zealand'],
    previousRoundSummary: { acceptedLeads: 0 } as any,
  } as any);

  // Must not recommend US, UK, Canada, or Australia metros
  assert.equal(nzPrompt.includes('San Francisco'), false);
  assert.equal(nzPrompt.includes('London'), false);
  assert.equal(nzPrompt.includes('Toronto'), false);
  assert.equal(nzPrompt.includes('Sydney'), false);

  // Must recommend NZ metros
  assert.ok(nzPrompt.includes('Wellington') || nzPrompt.includes('Christchurch') || nzPrompt.includes('Auckland'));

  // For open_global brief, no metros should be invented
  const globalContract = buildDeterministicProspectContract('B2B SaaS founders');
  const globalPrompt = buildStrategistPrompt({
    query: 'B2B SaaS founders',
    contract: globalContract,
    round: 2,
    remaining: 10,
    previousQueries: ['B2B SaaS founders'],
    previousRoundSummary: { acceptedLeads: 0 } as any,
  } as any);

  assert.equal(globalPrompt.includes('RECOMMENDED UNVISITED METROS'), false);
});
