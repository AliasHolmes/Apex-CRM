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
  let currentLength = 0;

  for (const rawBlock of blocks) {
    // One pathological search result must not blow the budget for every fallback
    // provider. Preserve the beginning (which contains provider/link metadata) and
    // truncate the long tail instead of splitting one prospect across calls.
    const block = String(rawBlock || '').slice(0, maxChars);
    if (!block) continue;

    if (current && currentLength + block.length > maxChars) {
      chunks.push(current);
      current = block;
      currentLength = block.length;
    } else {
      current += block;
      currentLength += block.length;
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
  const minimumOutput = Math.max(200, Math.floor(options.minimumOutputTokens ?? 800));
  const available = totalBudget - Math.max(0, Math.ceil(options.estimatedInputTokens)) - safetyTokens;

  if (available < 200) {
    throw new Error(
      `Insufficient LLM token budget: available tokens (${available}) below minimum viable output threshold (200).`,
    );
  }

  if (available < minimumOutput) {
    return Math.max(200, Math.min(configuredMax, available));
  }
  return Math.min(configuredMax, available);
}
