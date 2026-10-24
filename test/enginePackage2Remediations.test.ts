import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  buildQuerySignature,
  isNearDuplicateQuery,
} from '../server/leadSearch/querySignature.js';
import {
  isValidFlywheelCompany,
  buildAccountFlywheelItems,
} from '../server/leadSearch/stages/planStage.js';

describe('Package 2 Engine Remediations', () => {
  it('B2: separates owner and founder into distinct role classes so both survive deduplication', () => {
    const sigFounder = buildQuerySignature('site:linkedin.com/in/ founder AI digital service business USA');
    const sigOwner = buildQuerySignature('site:linkedin.com/in/ owner AI digital service business USA');
    const sigExecutive = buildQuerySignature('site:linkedin.com/in/ CEO AI digital service business USA');

    assert.equal(sigFounder.roleClass, 'founder');
    assert.equal(sigOwner.roleClass, 'owner');
    assert.equal(sigExecutive.roleClass, 'executive');

    // In a multi-role brief, an owner query is NOT dropped as a duplicate of a founder query
    assert.equal(isNearDuplicateQuery(sigOwner, [sigFounder]), false);
    assert.equal(isNearDuplicateQuery(sigExecutive, [sigFounder]), false);

    // Another founder query with identical topic IS recognized as a duplicate
    const sigFounderDup = buildQuerySignature('site:linkedin.com/in/ co-founder AI digital service business USA');
    assert.equal(sigFounderDup.roleClass, 'founder');
    assert.equal(isNearDuplicateQuery(sigFounderDup, [sigFounder]), true);
  });

  it('B9: sanitizes flywheel companies against role phrases and non-company strings', () => {
    // Valid companies
    assert.equal(isValidFlywheelCompany('Acme AI'), true);
    assert.equal(isValidFlywheelCompany('Magnet Mint'), true);
    assert.equal(isValidFlywheelCompany('EasyMate Technologies'), true);

    // Garbage / non-company strings discovered in session audit
    assert.equal(isValidFlywheelCompany('Consulting and Internal Roles'), false);
    assert.equal(isValidFlywheelCompany('The Opportunity FutureSight'), false);
    assert.equal(isValidFlywheelCompany('Job Responsibilities and Roles'), false);
    assert.equal(isValidFlywheelCompany('Career Opportunities'), false);
    assert.equal(isValidFlywheelCompany('Founder'), false);
    assert.equal(isValidFlywheelCompany('Directors'), false);
    assert.equal(isValidFlywheelCompany('ab'), false); // Too short
    assert.equal(isValidFlywheelCompany('12345'), false); // No letters

    // Flywheel items skip invalid company strings and construct clean queries
    const testCompanies = [
      'Consulting and Internal Roles', // Should be skipped
      'Acme AI',                       // Valid 1
      'Career Opportunities',         // Should be skipped
      'Magnet Mint',                   // Valid 2
    ];
    const items = buildAccountFlywheelItems(testCompanies, { person: { includeTitles: ['Founder'] } } as any, 8);
    assert.equal(items.length, 2);
    assert.equal(items[0].query.includes('"Acme AI"'), true);
    assert.equal(items[1].query.includes('"Magnet Mint"'), true);
  });
});
