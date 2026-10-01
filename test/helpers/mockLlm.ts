import { createLLMSessionCircuitBreaker } from '../../server/services/llm.js';
import type { SessionContext } from '../../server/leadSearch/pipelineTypes.js';
import type { ProspectContract } from '../../server/leadSearch/prospectContract.js';

const MANAGED_ENV = [
  'ATRIA_API_KEY', 'ATRIA_PRIORITY', 'OPENROUTER_API_KEY', 'GROQ_API_KEY', 'TOKEN_HARBOR_API_KEY',
  'OPENAI_API_KEY', 'BYESU_API_KEY', 'OPENAI_MODEL', 'OPENAI_BASE', 'LLM_COMPLETION_CACHE',
  'LLM_MAX_RETRIES', 'LLM_FAST_PROVIDER_IDS', 'LEAD_COMPANY_ATTRIBUTION_ENABLED',
];

/** Routes every LLM call to `respond` and guarantees no real provider is reachable. */
export function installMockLlm(respond: (requestBody: any) => unknown) {
  const originalFetch = globalThis.fetch;
  const snapshot = Object.fromEntries(MANAGED_ENV.map((key) => [key, process.env[key]]));
  for (const key of MANAGED_ENV) delete process.env[key];
  process.env.OPENAI_API_KEY = 'test-key';
  process.env.OPENAI_MODEL = 'test-model';
  process.env.LLM_COMPLETION_CACHE = 'false';
  process.env.LLM_MAX_RETRIES = '0';
  process.env.LEAD_COMPANY_ATTRIBUTION_ENABLED = 'false';
  const calls: any[] = [];
  globalThis.fetch = (async (_url: any, init?: any) => {
    const body = init?.body ? JSON.parse(String(init.body)) : {};
    calls.push(body);
    const content = JSON.stringify(respond(body));
    return new Response(
      JSON.stringify({
        model: 'test-model',
        choices: [{ finish_reason: 'stop', message: { content } }],
        usage: { prompt_tokens: 10, completion_tokens: 10, total_tokens: 20 },
      }),
      { status: 200, headers: { 'Content-Type': 'application/json' } },
    );
  }) as typeof fetch;
  return {
    calls,
    restore() {
      globalThis.fetch = originalFetch;
      for (const [key, value] of Object.entries(snapshot)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    },
  };
}

export function makeFounderContract(brief = 'Founders of AI automation agencies'): ProspectContract {
  return {
    version: 1,
    policyVersion: 'test-policy',
    brief,
    authorityRequired: true,
    exclusions: [],
    identitySpec: { roles: ['founder'], locations: [], companyTypes: [], industries: [] },
    requirements: [
      {
        id: 'req-role', description: 'Founder', sourcePhrase: 'founder', acceptableTerms: ['founder'],
        scope: 'person_role', importance: 'hard', evidenceModality: 'structured_profile',
        requirementClass: 'identity_hard', queryHardness: 'required_in_every_query', queryable: true,
      },
    ],
    initialQueries: [],
  } as any;
}

export function makeJudgeContext(contract: ProspectContract): { ctx: SessionContext; logs: string[] } {
  const logs: string[] = [];
  const ctx = {
    config: {
      sessionId: `test-session-${Date.now()}`, promptQuery: contract.brief, targetLimit: 10,
      maxRounds: 1, contract, judgeConcurrency: 1,
    } as any,
    state: { abortController: new AbortController(), llmCircuitBreaker: createLLMSessionCircuitBreaker(), qualifiedLeads: [] } as any,
    ports: {} as any,
    logEvent: (msg: string) => { logs.push(msg); },
    recordTrace: (event: any) => event,
  } as SessionContext;
  return { ctx, logs };
}
