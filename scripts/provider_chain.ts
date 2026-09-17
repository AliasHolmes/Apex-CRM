/**
 * Reports the LLM provider chain exactly as the running app would build it,
 * loading the real .env. Read-only: makes no network calls.
 */
import dotenv from 'dotenv';

dotenv.config();

const show = (label: string) => {
  // Re-import with a cache-busting suffix so each scenario re-reads process.env.
  return import(`../server/services/llm.ts?chain=${label}-${Date.now()}`);
};

console.log('ATRIA_API_KEY    =', process.env.ATRIA_API_KEY ? 'set' : 'NOT SET');
console.log('ATRIA_PRIORITY   =', process.env.ATRIA_PRIORITY || '(unset -> fallback)');
console.log('');

const llm1: any = await show('as-configured');
const chain1 = llm1.getLLMProviderSummaries();
console.log('chain as configured in .env:');
chain1.forEach((p: any, i: number) => console.log(`  ${i + 1}. ${p.id.padEnd(12)} ${(p.name || "?").padEnd(12)} ${p.model.padEnd(28)} ${p.configured ? 'configured' : 'UNCONFIGURED'}`));
console.log('  primary ->', llm1.getPrimaryLLMProvider(), '/', llm1.getPrimaryLLMModel());

// Now the same, with the key supplied, to show exactly where Atria lands.
process.env.ATRIA_API_KEY = process.env.ATRIA_API_KEY || 'placeholder-for-ordering-check';
const llm2: any = await show('with-key');
const chain2 = llm2.getLLMProviderSummaries();
console.log('\nchain with ATRIA_API_KEY supplied (fallback mode):');
chain2.forEach((p: any, i: number) => console.log(`  ${i + 1}. ${p.id.padEnd(12)} ${(p.name || "?").padEnd(12)} ${p.model.padEnd(28)} ${p.configured ? 'configured' : 'UNCONFIGURED'}`));
console.log('  primary ->', llm2.getPrimaryLLMProvider(), '/', llm2.getPrimaryLLMModel());
console.log('  atria position:', chain2.findIndex((p: any) => p.id === 'atria') + 1, 'of', chain2.length);

process.env.ATRIA_PRIORITY = 'primary';
const llm3: any = await show('promoted');
const chain3 = llm3.getLLMProviderSummaries();
console.log('\nchain with ATRIA_PRIORITY=primary:');
console.log('  atria position:', chain3.findIndex((p: any) => p.id === 'atria') + 1, 'of', chain3.length);
console.log('  primary ->', llm3.getPrimaryLLMProvider(), '/', llm3.getPrimaryLLMModel());
