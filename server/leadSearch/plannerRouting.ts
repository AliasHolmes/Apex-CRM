/**
 * Provider ordering for the low-latency planning family (query strategist, intent-signal
 * synthesis, LinkedIn post-intent classification). These prompts are small and structured,
 * routed to the primary provider (Byesu) with OpenRouter and Groq failsafes behind it.
 */

export function resolvePlannerProviderOrder(): string[] {
  const env = process.env.LEAD_PLANNER_PROVIDER_ORDER;
  if (env && env.trim()) {
    return env.split(",").map((s) => s.trim().toLowerCase()).filter(Boolean);
  }
  // Fast tier: Primary (OmniRoute/Gemini), Byesu secondary, then OpenRouter and Groq failsafes.
  return ["primary", "byesu", "openrouter", "groq"];
}

/** Hard per-provider timeouts for planning-family calls: bounded, latency-sensitive work. */
export const PLANNER_PROVIDER_HARD_TIMEOUT_MS: Record<string, number> = {
  primary: 75_000,
  byesu: 25_000,
  openrouter: 25_000,
  groq: 15_000,
};

/**
 * Provider ordering for judge retry escalation. When an initial single-candidate evaluation on
 * OmniRoute times out or encounters a transient error, the retry escalates immediately across
 * providers, targeting Byesu (GPT-6.1 Sol) first to guarantee diverse upstream infrastructure.
 */
export function resolveJudgeRetryProviderOrder(): string[] {
  const env = process.env.LEAD_JUDGE_RETRY_PROVIDER_ORDER;
  if (env && env.trim()) {
    return env.split(",").map((s) => s.trim().toLowerCase()).filter(Boolean);
  }
  return ["byesu", "primary", "openrouter", "groq"];
}
