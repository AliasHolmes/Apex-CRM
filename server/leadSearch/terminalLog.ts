/**
 * terminalLog.ts
 *
 * Provides ANSI-colorized formatting for LLM console events on the terminal,
 * while keeping persistent session logs (DB, WebSocket, SSE) clean plain text.
 */

// ANSI escape sequences
export const ANSI = {
  reset: "\x1b[0m",
  bold: "\x1b[1m",
  dim: "\x1b[90m",
  red: "\x1b[31m",
  green: "\x1b[32m",
  yellow: "\x1b[33m",
  magenta: "\x1b[35m",
  cyan: "\x1b[36m",
  brightBlue: "\x1b[94m",
} as const;

const TIMESTAMP_PREFIX_RE = /^(\[\d{4}-\d{2}-\d{2}T[0-9:.]+Z\])\s+(.*)$/;
const HAS_ANSI_RE = /\x1b\[[0-9;]*m/;

export function formatLatencySeconds(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return "0.0s";
  const sec = ms / 1000;
  if (sec < 0.1) {
    return `${(Math.round(sec * 1000) / 1000).toFixed(2)}s`;
  }
  if (sec < 1) {
    const rounded = Math.round(sec * 100) / 100;
    return Number.isInteger(rounded * 10) ? `${rounded.toFixed(1)}s` : `${rounded}s`;
  }
  const rounded = Math.round(sec * 10) / 10;
  return Number.isInteger(rounded) ? `${rounded}.0s` : `${rounded}s`;
}

// Strict parser for standard structured [LLM 200 OK] lines (accepts both ms and s)
const LLM_200_STRUCTURED_RE =
  /^\[LLM 200 OK\]\s+([^\s\u00b7\u00b7]+)\s+[\u00b7\u00b7]\s+model:\s+([^\s\u00b7\u00b7]+)\s+[\u00b7\u00b7]\s+([\d,]+(?:\.\d+)?(?:ms|s))(?:\s+[\u00b7\u00b7]\s+([\d,]+ tok))?(?:\s+(.*))?$/;

// Generic fallback for any other [LLM 200 OK] lines
const LLM_200_GENERIC_RE = /^\[LLM 200 OK\](?:\s+(.*))?$/;

// [LLM ERROR ...] lines
const LLM_ERROR_RE = /^(\[LLM ERROR(?:\s+[^\]]+)?\])(?:\s+(.*))?$/;

// [LLM WARN ...] lines
const LLM_WARN_RE = /^(\[LLM WARN(?:\s+[^\]]+)?\])(?:\s+(.*))?$/;

// [LLM ... RATE LIMIT] lines
const LLM_RATE_LIMIT_RE = /^(\[LLM\s+(?:(?:\d+|FAIL)\s+)?RATE LIMIT\])(?:\s+(.*))?$/i;

/**
 * Transforms an LLM log line into a colorized terminal string using ANSI escape codes.
 * If the line is already colorized, or does not contain LLM log tokens, it is returned unchanged.
 */
export function colorizeTerminalLog(line: string): string {
  if (!line || typeof line !== "string") return line;
  if (process.env.NO_COLOR && process.env.NO_COLOR !== "0") return line;
  if (HAS_ANSI_RE.test(line)) return line;

  let tsPrefix = "";
  let body = line;

  const tsMatch = line.match(TIMESTAMP_PREFIX_RE);
  if (tsMatch) {
    tsPrefix = `${ANSI.dim}${tsMatch[1]}${ANSI.reset} `;
    body = tsMatch[2];
  }

  // 1. Structured [LLM 200 OK] log
  const match200 = body.match(LLM_200_STRUCTURED_RE);
  if (match200) {
    const [, provider, model, latency, tokens, details] = match200;
    const provStr = ` ${ANSI.bold}${provider}${ANSI.reset}`;
    const modelStr = ` \u00b7 model: ${ANSI.cyan}${model}${ANSI.reset}`;
    const latStr = ` \u00b7 ${ANSI.yellow}${latency}${ANSI.reset}`;
    const tokStr = tokens ? ` \u00b7 ${ANSI.magenta}${tokens}${ANSI.reset}` : "";
    const detStr = details ? ` ${ANSI.brightBlue}${details}${ANSI.reset}` : "";
    return `${tsPrefix}${ANSI.green}[LLM 200 OK]${ANSI.reset}${provStr}${modelStr}${latStr}${tokStr}${detStr}`;
  }

  // 2. Generic [LLM 200 OK] log
  const match200Gen = body.match(LLM_200_GENERIC_RE);
  if (match200Gen) {
    const rest = match200Gen[1] ? ` ${ANSI.bold}${match200Gen[1]}${ANSI.reset}` : "";
    return `${tsPrefix}${ANSI.green}[LLM 200 OK]${ANSI.reset}${rest}`;
  }

  // 3. [LLM ERROR] log
  const matchErr = body.match(LLM_ERROR_RE);
  if (matchErr) {
    const [, tag, rest] = matchErr;
    const restStr = rest ? ` ${ANSI.red}${rest}${ANSI.reset}` : "";
    return `${tsPrefix}${ANSI.red}${tag}${ANSI.reset}${restStr}`;
  }

  // 4. [LLM WARN] log
  const matchWarn = body.match(LLM_WARN_RE);
  if (matchWarn) {
    const [, tag, rest] = matchWarn;
    const restStr = rest ? ` ${ANSI.yellow}${rest}${ANSI.reset}` : "";
    return `${tsPrefix}${ANSI.yellow}${tag}${ANSI.reset}${restStr}`;
  }

  // 5. [LLM RATE LIMIT] log
  const matchRate = body.match(LLM_RATE_LIMIT_RE);
  if (matchRate) {
    const [, tag, rest] = matchRate;
    const restStr = rest ? ` ${ANSI.yellow}${rest}${ANSI.reset}` : "";
    return `${tsPrefix}${ANSI.yellow}${tag}${ANSI.reset}${restStr}`;
  }

  // Non-LLM lines remain unchanged
  return line;
}
