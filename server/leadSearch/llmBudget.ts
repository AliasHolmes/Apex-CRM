const DEFAULT_CHARS_PER_TOKEN = 4;

export function estimateTokenCount(value: unknown, charsPerToken = DEFAULT_CHARS_PER_TOKEN): number {
  const normalizedCharsPerToken = Number.isFinite(charsPerToken) && charsPerToken > 0
    ? charsPerToken
    : DEFAULT_CHARS_PER_TOKEN;
  return Math.ceil(String(value || '').length / normalizedCharsPerToken);
}

export function chunkEvidenceBlocksByTokenBudget(blocks: string[], maxTokens: number): string[] {
  const normalizedBudget = Math.max(1, Math.floor(maxTokens));
  const maxChars = normalizedBudget * DEFAULT_CHARS_PER_TOKEN;
  const chunks: string[] = [];
  let current = '';

  for (const rawBlock of blocks) {
    // One pathological search result must not blow the budget for every fallback
    // provider. Preserve the beginning (which contains provider/link metadata) and
    // truncate the long tail instead of splitting one prospect across calls.
    const block = String(rawBlock || '').slice(0, maxChars);
    if (!block) continue;

    if (current && estimateTokenCount(current + block) > normalizedBudget) {
      chunks.push(current);
      current = block;
    } else {
      current += block;
    }
  }

  if (current) chunks.push(current);
  return chunks;
}

export function fitOutputTokenBudget(options: {
  configuredMaxTokens: number;
  estimatedInputTokens: number;
  totalTokenBudget: number;
  safetyTokens?: number;
  minimumOutputTokens?: number;
}): number {
  const configuredMax = Math.max(1, Math.floor(options.configuredMaxTokens));
  const totalBudget = Math.max(1, Math.floor(options.totalTokenBudget));
  const safetyTokens = Math.max(0, Math.floor(options.safetyTokens ?? 400));
  const minimumOutput = Math.max(1, Math.floor(options.minimumOutputTokens ?? 800));
  const available = totalBudget - Math.max(0, Math.ceil(options.estimatedInputTokens)) - safetyTokens;

  // The caller sizes evidence chunks to leave at least minimumOutput available.
  // If unexpected schema growth consumes that reserve, never exceed the total
  // provider budget just to preserve the preferred minimum.
  if (available < minimumOutput) return Math.max(1, Math.min(configuredMax, available));
  return Math.min(configuredMax, available);
}
