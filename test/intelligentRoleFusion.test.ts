import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { buildDeterministicProspectContract, normalizeProspectContract } from '../server/leadSearch/prospectContract.js';

describe('Intelligent Role Fusion & Any-Of Unification', () => {
  it('fuses owner/founder into a single person_role requirement with any_of match rule', () => {
    const contract = buildDeterministicProspectContract('AI agency owner/founder from USA');
    
    const roleReqs = contract.requirements.filter(r => r.scope === 'person_role');
    assert.equal(roleReqs.length, 1, 'Should create exactly 1 person_role requirement instead of splitting into 2');
    
    const roleReq = roleReqs[0];
    assert.equal(roleReq.matchRule, 'any_of', 'Should have matchRule any_of');
    assert.equal(roleReq.groupId, 'person_role_group');
    
    const terms = roleReq.acceptableTerms.map(t => t.toLowerCase());
    assert.ok(terms.includes('owner'), 'Should include owner');
    assert.ok(terms.includes('founder'), 'Should include founder');
    assert.ok(terms.includes('ceo'), 'Should include CEO');
    assert.ok(terms.includes('managing director'), 'Should include managing director');
  });

  it('merges multiple person_role requirements in normalizeProspectContract', () => {
    const fallback = buildDeterministicProspectContract('Software agency founder or CEO');
    const compiled = normalizeProspectContract({
      requirements: [
        {
          id: 'person_role-1',
          scope: 'person_role',
          importance: 'hard',
          sourcePhrase: 'founder',
          acceptableTerms: ['founder', 'co-founder']
        },
        {
          id: 'person_role-2',
          scope: 'person_role',
          importance: 'hard',
          sourcePhrase: 'CEO',
          acceptableTerms: ['CEO', 'chief executive officer']
        }
      ]
    }, 'Software agency founder or CEO', fallback);

    const roleReqs = compiled.requirements.filter(r => r.scope === 'person_role');
    assert.equal(roleReqs.length, 1, 'Should consolidate all person_role items into 1 requirement');
    assert.equal(roleReqs[0].matchRule, 'any_of');
  });

  it('preserves locations and company types alongside unified role requirement', () => {
    const contract = buildDeterministicProspectContract('AI agency owner/founder from USA');
    
    const locReqs = contract.requirements.filter(r => r.scope === 'person_location');
    const compReqs = contract.requirements.filter(r => r.scope === 'company_type');
    
    assert.ok(locReqs.length >= 1, 'Should have location requirement');
    assert.ok(compReqs.length >= 1, 'Should have company type requirement');
    assert.equal(contract.policyVersion, 'evidence-contract-v7');
  });
});
