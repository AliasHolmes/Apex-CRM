import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  isEligibleForSafetyNet,
  promoteSafetyNetCandidates,
} from '../server/leadSearch/stages/judgeStage.js';

describe('isEligibleForSafetyNet (shared safety-net eligibility core)', () => {
  // The live safety net in discoveryEngine.ts:2086 calls this helper. Before 2026-09-16 the
  // same three checks were duplicated inline at that call site while this exported helper had
  // no production caller at all, so the rule had two definitions and only the dead one was
  // covered. These assertions pin the shared rule itself.
  //
  // A permissive contract is used deliberately: with the agency contract below,
  // checkStrictContradiction() returns non-null for any minimal lead, so the helper would
  // return false at the contradiction branch and every later assertion would pass vacuously.
  const permissiveContract = {
    brief: 'software engineers',
    requirements: [],
    exclusions: [],
    policyVersion: 'test',
  } as any;
  const plainLead = { currentTitle: 'CEO', fullName: 'Jane Doe' };

  it('admits a lead with no disqualifying signal', () => {
    assert.equal(isEligibleForSafetyNet(plainLead, permissiveContract, null), true);
  });

  it('rejects auto-failed leads', () => {
    assert.equal(
      isEligibleForSafetyNet({ ...plainLead, _autoFailed: true }, permissiveContract, null),
      false,
    );
  });

  it('rejects leads whose judge insight is hard_fail', () => {
    // Assert the otherwise-eligible baseline first, so this cannot pass vacuously via the
    // contradiction branch.
    assert.equal(isEligibleForSafetyNet(plainLead, permissiveContract, null), true);
    assert.equal(
      isEligibleForSafetyNet(plainLead, permissiveContract, { status: 'hard_fail' }),
      false,
    );
  });

  it('admits a non-hard_fail insight', () => {
    assert.equal(
      isEligibleForSafetyNet(plainLead, permissiveContract, { status: 'qualified', score: 8 }),
      true,
    );
  });

  it('treats an absent insight as eligible (third argument is optional)', () => {
    assert.equal(isEligibleForSafetyNet(plainLead, permissiveContract, undefined), true);
    assert.equal(isEligibleForSafetyNet(plainLead, permissiveContract), true);
  });
});

describe('promoteSafetyNetCandidates (live safety-net promotion)', () => {
  // Extracted from the inline block in discoveryEngine so the promotion policy is a named,
  // testable unit. The caller owns the ENABLE_UNVERIFIED_SAFETY_NET_PROMOTION gate; this
  // function owns what happens once the gate is open.
  const permissiveContract = {
    brief: 'software engineers',
    requirements: [],
    exclusions: [],
    policyVersion: 'test',
  } as any;

  const mkLead = (over: Record<string, any> = {}) => ({
    fullName: 'Lead',
    currentTitle: 'CEO',
    ...over,
  });

  it('promotes at most `shortfall` leads and reports the counts', () => {
    const acceptedLeads = [
      mkLead({ id: 'a', fullName: 'A' }),
      mkLead({ id: 'b', fullName: 'B' }),
      mkLead({ id: 'c', fullName: 'C' }),
    ];
    const qualifiedLeads: any[] = [];

    const res = promoteSafetyNetCandidates({
      acceptedLeads,
      qualifiedLeads,
      contract: permissiveContract,
      shortfall: 2,
    });

    assert.equal(res.promoted, 2);
    assert.equal(res.considered, 3);
    assert.equal(qualifiedLeads.length, 2);
  });

  it('promotes nothing when the shortfall is zero', () => {
    const qualifiedLeads: any[] = [];
    const res = promoteSafetyNetCandidates({
      acceptedLeads: [mkLead({ id: 'a' })],
      qualifiedLeads,
      contract: permissiveContract,
      shortfall: 0,
    });
    assert.equal(res.promoted, 0);
    assert.equal(qualifiedLeads.length, 0);
  });

  it('marks promoted leads as rescued with an explanation', () => {
    const qualifiedLeads: any[] = [];
    promoteSafetyNetCandidates({
      acceptedLeads: [mkLead({ id: 'a', fullName: 'A' })],
      qualifiedLeads,
      contract: permissiveContract,
      shortfall: 1,
    });

    assert.equal(qualifiedLeads[0].isRescued, true);
    assert.equal(qualifiedLeads[0].qualification.verdict, 'rescued');
    assert.match(qualifiedLeads[0].whyThisLead, /Safety Net/);
    assert.equal(typeof qualifiedLeads[0].finalSelectionScore, 'number');
  });

  it('never promotes a lead that is already qualified (matched by id)', () => {
    const already = mkLead({ id: 'dup', fullName: 'Dup' });
    const fresh = mkLead({ id: 'new', fullName: 'New' });
    const qualifiedLeads: any[] = [already];

    const res = promoteSafetyNetCandidates({
      acceptedLeads: [already, fresh],
      qualifiedLeads,
      contract: permissiveContract,
      shortfall: 5,
    });

    assert.equal(res.promoted, 1);
    assert.equal(
      qualifiedLeads.filter((l) => l.fullName === 'Dup').length,
      1,
      'the already-qualified lead must not be appended a second time',
    );
    assert.ok(qualifiedLeads.some((l) => l.fullName === 'New'));
  });

  it('never promotes a lead already qualified by LinkedIn URL', () => {
    const url = 'https://www.linkedin.com/in/same';
    const already = mkLead({ fullName: 'Dup', contactDetails: { linkedinUrl: url } });
    const sameUrl = mkLead({ id: 'other', fullName: 'SameUrl', contactDetails: { linkedinUrl: url } });
    const qualifiedLeads: any[] = [already];

    const res = promoteSafetyNetCandidates({
      acceptedLeads: [sameUrl],
      qualifiedLeads,
      contract: permissiveContract,
      shortfall: 5,
    });

    assert.equal(res.promoted, 0);
    assert.equal(res.considered, 0);
    assert.equal(qualifiedLeads.length, 1);
  });

  it('skips auto-failed, hard-fail, and disqualified leads', () => {
    const acceptedLeads = [
      mkLead({ id: 'auto', fullName: 'Auto', _autoFailed: true }),
      mkLead({ id: 'hf', fullName: 'HardFail', judgmentInsight: { status: 'hard_fail' } }),
      mkLead({ id: 'disq', fullName: 'Disq', qualification: { verdict: 'disqualified' } }),
      mkLead({ id: 'ok', fullName: 'Ok' }),
    ];
    const qualifiedLeads: any[] = [];

    const res = promoteSafetyNetCandidates({
      acceptedLeads,
      qualifiedLeads,
      contract: permissiveContract,
      shortfall: 10,
    });

    assert.equal(res.considered, 1, 'only the clean lead should be eligible');
    assert.equal(qualifiedLeads.length, 1);
    assert.equal(qualifiedLeads[0].fullName, 'Ok');
  });
});
