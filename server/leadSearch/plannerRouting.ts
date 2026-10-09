/**
 * Provider ordering for the low-latency planning family (query strategist, intent-signal
 * synthesis, LinkedIn post-intent classification). These prompts are small and structured,
 * so they belong on the fast router (Byesu) with the primary engine provider (Atria) as
 * the second choice and the Mistral failsafe behind it - see
 * docs/adr/0011-atria-primary-with-byesu-second-priority.md.
 */

export function resolvePlannerProviderOrder(): string[] {
  const env = process.env.LEAD_PLANNER_PROVIDER_ORDER;
  if (env && env.trim()) {
    return env.split(",").map((s) => s.trim().toLowerCase()).filter(Boolean);
  }
  // Fast tier: prefer the low-latency router (Byesu) for planning, then the primary
  // engine provider (Atria), then the OpenRouter/Mistral failsafe.
  return ["primary", "atria", "openrouter"];
}

/** Hard per-provider timeouts for planning-family calls: bounded, latency-sensitive work. */
export const PLANNER_PROVIDER_HARD_TIMEOUT_MS: Record<string, number> = {
  primary: 20_000,
  openrouter: 25_000,
  atria: 25_000,
};
