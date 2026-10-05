import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { LEAD_LINK_SCHEME, linkProspectNames } from '../src/lib/linkProspectNames';

const names = new Map([
  ['Ada Lovelace', 'lead-1'],
  ['Ada Lovelace Jr', 'lead-2'],
  ['Grace Hopper', 'lead 3'],
]);

describe('linkProspectNames', () => {
  it('links known names to the lead scheme', () => {
    assert.equal(
      linkProspectNames('Contact Ada Lovelace today.', names),
      `Contact [Ada Lovelace](${LEAD_LINK_SCHEME}lead-1) today.`,
    );
  });

  it('prefers the longest matching name', () => {
    assert.equal(
      linkProspectNames('Ada Lovelace Jr is next.', names),
      `[Ada Lovelace Jr](${LEAD_LINK_SCHEME}lead-2) is next.`,
    );
  });

  it('encodes ids and links every occurrence', () => {
    const output = linkProspectNames('Grace Hopper and Grace Hopper', names);
    assert.equal(output.match(/apex-lead:lead%203/g)?.length, 2);
  });

  it('does not touch existing links or code spans', () => {
    const text = 'See [Ada Lovelace](https://example.com) and `Grace Hopper`.';
    assert.equal(linkProspectNames(text, names), text);
  });

  it('only matches whole names', () => {
    assert.equal(linkProspectNames('Grace Hoppers and xAda Lovelace', names), 'Grace Hoppers and xAda Lovelace');
  });

  it('returns the input untouched when there is nothing to link', () => {
    assert.equal(linkProspectNames('No names here.', names), 'No names here.');
    assert.equal(linkProspectNames('Ada Lovelace', new Map()), 'Ada Lovelace');
  });
});
