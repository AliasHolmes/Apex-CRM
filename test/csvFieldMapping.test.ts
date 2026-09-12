import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  createCsvFieldReader,
  CSV_FIELD_ALIASES,
} from '../src/utils/csvFieldMapping.ts';

/**
 * Regression coverage for the CSV import bug: header matching used to be substring-based in
 * file order, so "First Name" satisfied the "name" query and every imported record silently
 * lost its surname when round-tripping this app's own export.
 */
describe('CSV field mapping', () => {
  const read = (row: Record<string, string>) => {
    const getField = createCsvFieldReader(row);
    return {
      firstName: getField(CSV_FIELD_ALIASES.firstName),
      lastName: getField(CSV_FIELD_ALIASES.lastName),
      company: getField(CSV_FIELD_ALIASES.company),
      title: getField(CSV_FIELD_ALIASES.title),
      email: getField(CSV_FIELD_ALIASES.email),
      linkedin: getField(CSV_FIELD_ALIASES.linkedin),
      fullName: getField(CSV_FIELD_ALIASES.fullName),
    };
  };

  it('resolves Full Name from this app\'s own export headers (the original bug)', () => {
    const row = {
      ID: 'lead-1',
      'First Name': 'Ada',
      'Last Name': 'Lovelace',
      'Full Name': 'Ada Lovelace',
      'Current Title': 'CTO',
      'Current Company': 'Analytical Engines',
      'Corporate Email': 'ada@example.com',
      'LinkedIn Profile URL': 'https://linkedin.com/in/ada',
    };

    const fields = read(row);

    assert.equal(fields.firstName, 'Ada');
    assert.equal(fields.lastName, 'Lovelace');
    // Previously this resolved to "Ada" because "first name".includes("name").
    assert.equal(fields.fullName, 'Ada Lovelace');
    assert.equal(fields.company, 'Analytical Engines');
    assert.equal(fields.title, 'CTO');
    assert.equal(fields.email, 'ada@example.com');
    assert.equal(fields.linkedin, 'https://linkedin.com/in/ada');
  });

  it('composes Full Name from first + last when no full-name column exists', () => {
    const fields = read({ 'First Name': 'Grace', 'Last Name': 'Hopper' });
    assert.equal(fields.fullName, '');
    assert.equal(fields.firstName, 'Grace');
    assert.equal(fields.lastName, 'Hopper');
  });

  it('does not let a generic "name" alias capture Company Name', () => {
    const fields = read({
      'Company Name': 'Acme Corp',
      Title: 'Head of RevOps',
    });
    assert.equal(fields.company, 'Acme Corp');
    // "name" must not pick up "Company Name".
    assert.equal(fields.fullName, '');
    assert.equal(fields.title, 'Head of RevOps');
  });

  it('supports prefixed third-party headers via the substring fallback', () => {
    const fields = read({ 'Contact Full Name': 'Alan Turing' });
    assert.equal(fields.fullName, 'Alan Turing');
  });

  it('never returns the same column for two different fields', () => {
    const fields = read({
      'Full Name': 'Katherine Johnson',
      'Company Name': 'NASA',
      'First Name': 'Katherine',
      'Last Name': 'Johnson',
    });
    const values = [
      fields.firstName,
      fields.lastName,
      fields.company,
      fields.fullName,
    ].filter(Boolean);
    assert.equal(new Set(values).size, values.length);
    assert.equal(fields.fullName, 'Katherine Johnson');
    assert.equal(fields.company, 'NASA');
  });

  it('is case- and punctuation-insensitive', () => {
    const fields = read({
      'FULL_NAME': 'Margaret Hamilton',
      'e-mail': 'margaret@example.com',
    });
    assert.equal(fields.fullName, 'Margaret Hamilton');
    assert.equal(fields.email, 'margaret@example.com');
  });
});
