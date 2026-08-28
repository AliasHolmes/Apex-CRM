import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test, { after } from 'node:test';
import express from 'express';
import type { Server } from 'node:http';

const dataDirectory = mkdtempSync(path.join(tmpdir(), 'apex-leads-limit-test-'));
process.env.APEX_DB_PATH = path.join(dataDirectory, 'leads.sqlite');

const {
  getLeadsDb,
  upsertLeads,
} = await import('../server/db.ts');

const apiRouter = (await import('../server/routes/api.ts')).default;

const app = express();
app.use(express.json());
app.use('/api', apiRouter);

let server: Server;
let baseUrl: string;

test.before(async () => {
  await new Promise<void>((resolve) => {
    server = app.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      if (typeof addr === 'object' && addr !== null) {
        baseUrl = `http://127.0.0.1:${addr.port}`;
      }
      resolve();
    });
  });

  // Seed 600 leads into database
  const batchSize = 100;
  for (let b = 0; b < 6; b++) {
    const leads = Array.from({ length: batchSize }, (_, i) => {
      const idx = b * batchSize + i;
      return {
        id: `limit-test-lead-${idx}`,
        profile: {
          id: `profile-${idx}`,
          fullName: `Lead Number ${idx}`,
          currentCompany: `Company ${idx % 10}`,
          currentTitle: 'Executive',
        },
        stage: idx % 2 === 0 ? 'SCRAPED' : 'ENRICHED',
        createdAt: new Date(Date.now() - idx * 1000).toISOString(),
        updatedAt: new Date(Date.now() - idx * 1000).toISOString(),
        tags: [],
      };
    });
    upsertLeads(leads);
  }
});

after(() => {
  if (server) server.close();
  try {
    getLeadsDb().close();
  } catch {}
  rmSync(dataDirectory, { recursive: true, force: true });
});

test('unfiltered GET /api/leads returns all leads without 500 limit cap', async () => {
  const response = await fetch(`${baseUrl}/api/leads`);
  assert.equal(response.status, 200);

  const data = await response.json();
  assert.equal(data.total, 600);
  assert.ok(Array.isArray(data.leads));
  assert.equal(data.leads.length, 600);
});

test('GET /api/leads honors explicit pagination limit when provided', async () => {
  const response = await fetch(`${baseUrl}/api/leads?limit=50`);
  assert.equal(response.status, 200);

  const data = await response.json();
  assert.equal(data.total, 600);
  assert.equal(data.leads.length, 50);
});

test('GET /api/leads supports limits above 2000 up to 5000', async () => {
  const response = await fetch(`${baseUrl}/api/leads?limit=3000`);
  assert.equal(response.status, 200);

  const data = await response.json();
  assert.equal(data.total, 600);
  assert.equal(data.leads.length, 600);
});
