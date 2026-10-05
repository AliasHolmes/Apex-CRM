import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';

const ROOT = process.cwd();
const css = readFileSync(join(ROOT, 'src', 'index.css'), 'utf8');

type Theme = Record<string, [number, number, number]>;

function parseBlock(selector: string): Theme {
  const start = css.indexOf(`${selector} {`);
  assert.ok(start >= 0, `index.css must define a ${selector} block`);
  const end = css.indexOf('}', start);
  const body = css.slice(start, end);
  const theme: Theme = {};
  for (const match of body.matchAll(/--([a-z0-9-]+):\s*([\d.]+)\s+([\d.]+)%\s+([\d.]+)%\s*;/g)) {
    theme[match[1]] = [Number(match[2]), Number(match[3]), Number(match[4])];
  }
  return theme;
}

function hslToRgb([h, s, l]: [number, number, number]): [number, number, number] {
  const sat = s / 100;
  const light = l / 100;
  const k = (n: number) => (n + h / 30) % 12;
  const a = sat * Math.min(light, 1 - light);
  const f = (n: number) => light - a * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1)));
  return [f(0), f(8), f(4)];
}

function luminance(color: [number, number, number]): number {
  const [r, g, b] = hslToRgb(color).map((channel) =>
    channel <= 0.03928 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4,
  );
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function contrast(a: [number, number, number], b: [number, number, number]): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

const themes: Array<[string, Theme]> = [
  ['light', parseBlock(':root')],
  ['dark', parseBlock('.dark')],
];

const TEXT_PAIRS: Array<[string, string]> = [
  ['foreground', 'background'],
  ['foreground', 'card'],
  ['card-foreground', 'card'],
  ['popover-foreground', 'popover'],
  ['muted-foreground', 'background'],
  ['muted-foreground', 'card'],
  ['muted-foreground', 'muted'],
  ['primary-foreground', 'primary'],
  ['destructive-foreground', 'destructive'],
  ['secondary-foreground', 'secondary'],
  ['accent-foreground', 'accent'],
  ['success', 'background'],
  ['success', 'card'],
  ['warning', 'background'],
  ['warning', 'card'],
  ['danger', 'background'],
  ['danger', 'card'],
  ['info', 'background'],
  ['info', 'card'],
  ['primary', 'background'],
  ['primary', 'card'],
  ['success-foreground', 'success'],
  ['warning-foreground', 'warning'],
  ['danger-foreground', 'danger'],
  ['info-foreground', 'info'],
];

describe('theme token contrast (WCAG AA 4.5:1)', () => {
  for (const [name, theme] of themes) {
    for (const [fg, bg] of TEXT_PAIRS) {
      it(`${name}: ${fg} on ${bg}`, () => {
        assert.ok(theme[fg], `${name} theme is missing --${fg}`);
        assert.ok(theme[bg], `${name} theme is missing --${bg}`);
        const ratio = contrast(theme[fg], theme[bg]);
        assert.ok(ratio >= 4.5, `${fg} on ${bg} is ${ratio.toFixed(2)}:1 in the ${name} theme`);
      });
    }

    it(`${name}: defines the full stage ramp and chart palette`, () => {
      for (let index = 1; index <= 9; index += 1) assert.ok(theme[`stage-${index}`], `--stage-${index}`);
      for (let index = 1; index <= 5; index += 1) assert.ok(theme[`chart-${index}`], `--chart-${index}`);
    });
  }
});

function collectTsx(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) return collectTsx(full);
    return full.endsWith('.tsx') ? [full] : [];
  });
}

describe('semantic color usage', () => {
  it('keeps raw palette colors out of the app shell and workspace components', () => {
    const files = [join(ROOT, 'src', 'App.tsx'), ...collectTsx(join(ROOT, 'src', 'components')).filter((file) => !file.includes(`${join('components', 'ui')}`))];
    const raw = /\b(?:bg|text|border|ring|from|to|via|fill|stroke|shadow|divide|outline|decoration|accent|caret|placeholder)-(?:slate|indigo|violet|purple|amber|orange|emerald|green|rose|red|sky|cyan|blue|gray|zinc|neutral|stone)-\d{2,3}\b/g;
    const offenders: string[] = [];
    for (const file of files) {
      const lines = readFileSync(file, 'utf8').split('\n');
      lines.forEach((line, index) => {
        const hits = line.match(raw);
        if (hits) offenders.push(`${file.slice(ROOT.length + 1)}:${index + 1}: ${[...new Set(hits)].join(' ')}`);
      });
    }
    assert.deepEqual(offenders, []);
  });
});
