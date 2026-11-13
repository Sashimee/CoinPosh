import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const css = readFileSync(new URL('../styles.css', import.meta.url), 'utf8').replace(
  /\/\*[\s\S]*?\*\//g,
  '',
);

interface Rule {
  readonly selector: string;
  readonly declarations: Readonly<Record<string, string>>;
}

function rules(): Rule[] {
  const out: Rule[] = [];
  for (const [, selectors = '', body = ''] of css.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    const declarations: Record<string, string> = {};
    for (const declaration of body.split(';')) {
      const colon = declaration.indexOf(':');
      if (colon < 0) continue;
      declarations[declaration.slice(0, colon).trim()] = declaration.slice(colon + 1).trim();
    }
    for (const selector of selectors.split(','))
      out.push({ selector: selector.trim(), declarations });
  }
  return out;
}

/** Rules that paint the counter or anything inside it, wherever they live in the sheet. */
function odometerRules(): Rule[] {
  return rules().filter(({ selector }) => /\.cp-odo(?:-[a-z]+)?\b/.test(selector));
}

function splitTopLevel(value: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < value.length; i++) {
    const char = value[i];
    if (char === '(') depth++;
    else if (char === ')') depth--;
    else if (char === ',' && depth === 0) {
      parts.push(value.slice(start, i).trim());
      start = i + 1;
    }
  }
  parts.push(value.slice(start).trim());
  return parts;
}

/** The blur of each shadow in a `text-shadow` or `drop-shadow()` list, as written. */
function blurs(shadows: string): string[] {
  return splitTopLevel(shadows).map((shadow) => {
    const lengths = shadow
      .replace(/rgba?\([^)]*\)|color-mix\([^)]*\)|var\([^)]*\)/g, ' ')
      .split(/\s+/)
      .filter((token) => /^-?[\d.]+(?:px|em|rem)?$/.test(token));
    return lengths[2] ?? '0';
  });
}

describe('odometer glow', () => {
  it('reads its window through clipped wheel columns', () => {
    const [column] = odometerRules().filter(({ selector }) => selector === '.cp-odo-col');
    expect(column?.declarations.overflow).toBe('hidden');
  });

  it('puts no blurred text-shadow on the digits, which the columns would cut into boxes', () => {
    const shadowed = odometerRules().filter(({ declarations }) => 'text-shadow' in declarations);
    expect(shadowed.map(({ selector }) => selector)).toEqual(
      expect.arrayContaining(['.cp-odo', '.cp-wallet-chip .cp-odo']),
    );
    for (const { selector, declarations } of shadowed) {
      for (const blur of blurs(declarations['text-shadow'] ?? '')) {
        expect(parseFloat(blur), `${selector} text-shadow blur`).toBe(0);
      }
    }
  });

  it('blooms from the whole counter with a drop-shadow that scales with its size', () => {
    const [counter] = odometerRules().filter(({ selector }) => selector === '.cp-odo');
    const filter = counter?.declarations.filter ?? '';
    const glow = /^drop-shadow\((.*)\)$/.exec(filter);
    expect(glow, `.cp-odo filter "${filter}"`).not.toBeNull();
    const [blur = ''] = blurs(glow?.[1] ?? '');
    expect(blur).toMatch(/em$/);
    expect(parseFloat(blur)).toBeGreaterThan(0);
  });

  it('keeps the glow on every counter, the wallet chips included', () => {
    const overrides = odometerRules().filter(
      ({ selector, declarations }) => selector !== '.cp-odo' && 'filter' in declarations,
    );
    expect(overrides).toEqual([]);
  });
});
