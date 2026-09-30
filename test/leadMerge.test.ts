import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test, { after } from 'node:test';

const dataDirectory = mkdtempSync(path.join(tmpdir(), 'apex-lead-merge-'));
process.env.APEX_DB_PATH = path.join(dataDirectory, 'leads.sqlite');

const express = (await import('express')).default;
const apiRouter = (await import('../server/routes/api.ts')).default;
const { closeLeadsDb, getLeadsDb, readStoredLeadById, upsertLeadWithIdentity } = await import('../server/db.ts');

const app = express();
app.use(express.json());
app.use('/api', apiRouter);
const server = app.listen(0);
const baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api`;

after(() => {
  server.close();
  closeLeadsDb();
  rmSync(dataDirectory, { recursive: true, force: true });
});

const createLead = (id: string, profile: Record<string, unknown>) => ({
  id,
  stage: 'SCRAPED',
  createdAt: new Date().toISOString(),
  profile: { fullName: 'Jane Doe', currentCompany: 'Acme', currentTitle: 'CEO', contactDetails: {}, ...profile },
});

const merge = async (winnerId: string, duplicateId: string) => {
  const response = await fetch(`${baseUrl}/leads/${winnerId}/merge`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ duplicateId }),
  });
  return { status: response.status, body: await response.json() };
};

const identitiesFor = (leadId: string) =>
  (getLeadsDb()
    .prepare('SELECT identity_key FROM lead_identities WHERE lead_id = ? ORDER BY identity_key')
    .all(leadId) as { identity_key: string }[]).map((row) => row.identity_key);

test('merge succeeds when the duplicate owns an email the winner lacks', async () => {
  upsertLeadWithIdentity(createLead('merge-winner-1', {}));
  upsertLeadWithIdentity(createLead('merge-dup-1', {
    currentCompany: 'Acme Inc',
    contactDetails: { email: 'jane@acme.com' },
  }));

  const result = await merge('merge-winner-1', 'merge-dup-1');

  assert.equal(result.status, 200, JSON.stringify(result.body));
  assert.equal(readStoredLeadById('merge-dup-1'), null);
  assert.equal(readStoredLeadById('merge-winner-1')?.profile.contactDetails.email, 'jane@acme.com');
  assert.deepEqual(identitiesFor('merge-dup-1'), []);
});

test('merge keeps the duplicate identities that the merged profile no longer carries', async () => {
  upsertLeadWithIdentity(createLead('merge-winner-2', {
    fullName: 'Bob Roe',
    contactDetails: { linkedinUrl: 'https://www.linkedin.com/in/bobroe' },
  }));
  upsertLeadWithIdentity(createLead('merge-dup-2', {
    fullName: 'Bob Roe',
    currentCompany: 'Beta',
    contactDetails: { linkedinUrl: 'https://www.linkedin.com/in/bob-roe-123' },
  }));

  const result = await merge('merge-winner-2', 'merge-dup-2');
  assert.equal(result.status, 200, JSON.stringify(result.body));

  const winnerIdentities = identitiesFor('merge-winner-2');
  assert.ok(winnerIdentities.includes('linkedin:bobroe'));
  assert.ok(winnerIdentities.includes('linkedin:bob-roe-123'));

  // Re-importing the merged-away profile must resolve to the winner, not create a new lead.
  const reimport = upsertLeadWithIdentity(createLead('merge-reimport-2', {
    fullName: 'Bob Roe',
    currentCompany: 'Beta',
    contactDetails: { linkedinUrl: 'https://www.linkedin.com/in/bob-roe-123' },
  }));
  assert.equal(reimport.disposition, 'duplicate');
  assert.equal(reimport.lead.id, 'merge-winner-2');
});
