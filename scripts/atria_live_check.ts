/**
 * Live end-to-end check of the Atria provider against the REAL endpoint,
 * exercising the actual server/services/llm.ts code path (not mocks).
 *
 * DNS workaround: this machine's resolver cannot resolve api.atria-asi.ai
 * (see docs/ATRIA-ENDPOINT-PROBE-2026-09-16.md section 7). We override resolution
 * at the socket layer via an undici dispatcher so the `Host` header and TLS SNI
 * stay as api.atria-asi.ai. Pinning the IP in ATRIA_BASE does NOT work: the ALB
 * routes by Host and answers 503 for a bare-IP Host header.
 *
 * This is a diagnostic harness, NOT a production configuration. The real fix is
 * to make the resolver answer for this domain.
 */
import { Agent, setGlobalDispatcher } from 'undici';

const HOST = 'api.atria-asi.ai';
const PINNED_IPS = ['47.236.72.31', '47.84.81.102', '8.219.11.2'];

setGlobalDispatcher(
  new Agent({
    connect: {
      lookup(hostname: string, _options: unknown, callback: any) {
        if (hostname === HOST) {
          const address = PINNED_IPS[0];
          return callback(null, [{ address, family: 4 }]);
        }
        return callback(new Error(`unexpected hostname ${hostname}`));
      },
    },
  }),
);

process.env.LLM_GATEWAY_MODE = 'direct';
if (!process.env.ATRIA_API_KEY) {
  console.error(
    'ATRIA_API_KEY is not set.\n' +
      'Export it first, e.g.  ATRIA_API_KEY=atr_... npx tsx scripts/atria_live_check.ts\n' +
      'The key is deliberately not stored in this file.',
  );
  process.exit(2);
}
process.env.ATRIA_PRIORITY = 'primary';
process.env.ATRIA_MODEL = process.env.ATRIA_MODEL || 'Atria-Dawn-Preview';
delete process.env.OPENAI_API_KEY;
delete process.env.BYESU_API_KEY;
delete process.env.OPENROUTER_API_KEY;
delete process.env.GROQ_API_KEY;

const llm: any = await import('../server/services/llm.ts');

console.log(
  'registered providers:',
  llm.getLLMProviderSummaries().map((p: any) => `${p.id}${p.configured ? '' : '(unconfigured)'}`).join(', '),
);
console.log('primary ->', llm.getPrimaryLLMProvider(), '/', llm.getPrimaryLLMModel(), '\n');

let pass = 0;
let fail = 0;
function check(name: string, ok: boolean, detail = '') {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ' :: ' + detail : ''}`);
  ok ? pass++ : fail++;
}

// 1. Plain text call with adequate budget.
try {
  const res = await llm.openAIText('Reply with exactly: LIVE OK', undefined, { maxTokens: 400 });
  check('openAIText returns content', res.text.trim().length > 0, JSON.stringify(res.text.slice(0, 60)));
  check('provider reported as Atria', res.provider === 'Atria', res.provider);
} catch (e: any) {
  check('openAIText returns content', false, `${e.name}: ${String(e.message).slice(0, 160)}`);
}

// 2. The reasoning-model truncation guard, against the real endpoint.
try {
  const res = await llm.openAIText('Reply with exactly: LIVE OK', undefined, { maxTokens: 10 });
  check('tiny budget raises truncation error', false, `returned instead: ${JSON.stringify(res.text.slice(0, 40))}`);
} catch (e: any) {
  const cause = e.cause ?? e;
  const msg = String(cause.message || e.message);
  check('tiny budget raises truncation error', /truncated/.test(msg), msg.slice(0, 160));
  check('truncation is not circuit-breaking', llm.isCircuitBreakingProviderFailure(cause) === false);
}

// 3. Structured (JSON) call, the shape extractStage actually uses.
try {
  const out = await llm.openAIStructured(
    'Return a JSON object with key "leads": an array with one object having keys "name" and "title".',
    {
      type: 'object',
      properties: {
        leads: {
          type: 'array',
          items: {
            type: 'object',
            properties: { name: { type: 'string' }, title: { type: 'string' } },
            required: ['name', 'title'],
          },
        },
      },
      required: ['leads'],
    },
    'You return strict JSON only.',
    { maxTokens: 2000, reasoningEffort: 'low' },
  );
  const ok = out && Array.isArray(out.leads) && out.leads.length > 0;
  check('openAIStructured parses real JSON', !!ok, JSON.stringify(out).slice(0, 120));
} catch (e: any) {
  check('openAIStructured parses real JSON', false, `${e.name}: ${String(e.message).slice(0, 160)}`);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
