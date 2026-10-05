import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  DEFAULT_SENDER_PROFILE,
  parseSenderProfile,
  serializeSenderProfile,
} from '../src/lib/senderProfile';

describe('sender profile storage', () => {
  it('uses the defaults when nothing is stored', () => {
    assert.deepEqual(parseSenderProfile(null), DEFAULT_SENDER_PROFILE);
  });

  it('round-trips an edited profile', () => {
    const edited = { senderName: 'Sam', senderCompany: 'Acme', valueProposition: 'we help teams ship faster' };
    assert.deepEqual(parseSenderProfile(serializeSenderProfile(edited)), edited);
  });

  it('falls back field by field for partial or wrongly typed data', () => {
    assert.deepEqual(
      parseSenderProfile(JSON.stringify({ senderName: 'Sam', senderCompany: 42 })),
      { ...DEFAULT_SENDER_PROFILE, senderName: 'Sam' },
    );
  });

  it('survives corrupt storage and non-object JSON', () => {
    assert.deepEqual(parseSenderProfile('{oops'), DEFAULT_SENDER_PROFILE);
    assert.deepEqual(parseSenderProfile('[]'), DEFAULT_SENDER_PROFILE);
    assert.deepEqual(parseSenderProfile('"text"'), DEFAULT_SENDER_PROFILE);
  });

  it('keeps an intentionally cleared field empty', () => {
    const stored = JSON.stringify({ senderName: '', senderCompany: 'Acme', valueProposition: 'x' });
    assert.equal(parseSenderProfile(stored).senderName, '');
  });

  it('caps very long values', () => {
    const long = 'x'.repeat(5000);
    const parsed = parseSenderProfile(serializeSenderProfile({ senderName: long, senderCompany: 'a', valueProposition: 'b' }));
    assert.equal(parsed.senderName.length, 600);
  });
});
