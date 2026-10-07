import { describe, it } from 'node:test';
import assert from 'node:assert';
import { colorizeTerminalLog, formatLatencySeconds, ANSI } from '../server/leadSearch/terminalLog.js';

describe('colorizeTerminalLog', () => {
  it('colorizes the exact screenshot judge summary line with timestamp', () => {
    const raw =
      '[2026-10-04T23:28:53.911Z] [LLM 200 OK] Atria \u00b7 model: Atria-Dawn-Preview \u00b7 117139ms \u00b7 4,855 tok [Incremental Judge: 1/5 qualified]';
    const colored = colorizeTerminalLog(raw);

    assert.ok(colored.includes(`${ANSI.dim}[2026-10-04T23:28:53.911Z]${ANSI.reset}`));
    assert.ok(colored.includes(`${ANSI.green}[LLM 200 OK]${ANSI.reset}`));
    assert.ok(colored.includes(`${ANSI.bold}Atria${ANSI.reset}`));
    assert.ok(colored.includes(`${ANSI.cyan}Atria-Dawn-Preview${ANSI.reset}`));
    assert.ok(colored.includes(`${ANSI.yellow}117139ms${ANSI.reset}`));
    assert.ok(colored.includes(`${ANSI.magenta}4,855 tok${ANSI.reset}`));
    assert.ok(colored.includes(`${ANSI.brightBlue}[Incremental Judge: 1/5 qualified]${ANSI.reset}`));
  });

  it('colorizes LLM 200 line without timestamp', () => {
    const raw =
      '[LLM 200 OK] Atria \u00b7 model: Atria-Dawn-Preview \u00b7 45000ms \u00b7 1,200 tok [Strategist Planning: 4 queries]';
    const colored = colorizeTerminalLog(raw);

    assert.ok(colored.startsWith(`${ANSI.green}[LLM 200 OK]${ANSI.reset}`));
    assert.ok(colored.includes(`${ANSI.cyan}Atria-Dawn-Preview${ANSI.reset}`));
    assert.ok(colored.includes(`${ANSI.brightBlue}[Strategist Planning: 4 queries]${ANSI.reset}`));
  });

  it('colorizes LLM 200 line without tokens', () => {
    const raw =
      '[2026-10-04T23:28:53.911Z] [LLM 200 OK] OpenAI \u00b7 model: gpt-4o \u00b7 2500ms [Extraction Chunk 1/2: 8 leads]';
    const colored = colorizeTerminalLog(raw);

    assert.ok(colored.includes(`${ANSI.green}[LLM 200 OK]${ANSI.reset}`));
    assert.ok(colored.includes(`${ANSI.bold}OpenAI${ANSI.reset}`));
    assert.ok(colored.includes(`${ANSI.brightBlue}[Extraction Chunk 1/2: 8 leads]${ANSI.reset}`));
  });

  it('colorizes [LLM ERROR] lines in red', () => {
    const raw =
      '[2026-10-04T23:28:53.911Z] [LLM ERROR] Incremental judge batch 1 failed: timeout';
    const colored = colorizeTerminalLog(raw);

    assert.ok(colored.includes(`${ANSI.red}[LLM ERROR]${ANSI.reset}`));
    assert.ok(colored.includes(`${ANSI.red}Incremental judge batch 1 failed: timeout${ANSI.reset}`));
  });

  it('colorizes [LLM WARN] lines in yellow', () => {
    const raw =
      '[2026-10-04T23:28:53.911Z] [LLM WARN] LinkedIn Post Intent batch classification failed';
    const colored = colorizeTerminalLog(raw);

    assert.ok(colored.includes(`${ANSI.yellow}[LLM WARN]${ANSI.reset}`));
    assert.ok(colored.includes(`${ANSI.yellow}LinkedIn Post Intent batch classification failed${ANSI.reset}`));
  });

  it('leaves non-LLM lines completely untouched', () => {
    const raw =
      '[2026-10-04T23:26:56.771Z] Round 3 Company Attribution: evaluated 8 candidates (1 verified fit, 3 disqualifying contradictions).';
    const colored = colorizeTerminalLog(raw);

    assert.strictEqual(colored, raw);
  });

  it('colorizes LLM 200 line with latency in seconds', () => {
    const raw =
      '[2026-10-04T23:28:53.911Z] [LLM 200 OK] Atria \u00b7 model: Atria-Dawn-Preview \u00b7 117.1s \u00b7 4,855 tok [Incremental Judge: 1/5 qualified]';
    const colored = colorizeTerminalLog(raw);

    assert.ok(colored.includes(`${ANSI.yellow}117.1s${ANSI.reset}`));
    assert.ok(colored.includes(`${ANSI.green}[LLM 200 OK]${ANSI.reset}`));
  });

  it('formatLatencySeconds converts ms to clean seconds representation', () => {
    assert.strictEqual(formatLatencySeconds(117139), '117.1s');
    assert.strictEqual(formatLatencySeconds(45000), '45.0s');
    assert.strictEqual(formatLatencySeconds(2500), '2.5s');
    assert.strictEqual(formatLatencySeconds(450), '0.45s');
    assert.strictEqual(formatLatencySeconds(50), '0.05s');
    assert.strictEqual(formatLatencySeconds(0), '0.0s');
  });
});
