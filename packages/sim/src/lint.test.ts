import { ESLint, Linter } from 'eslint';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { determinismRules } from '../eslint.determinism.js';

const packageDir = fileURLToPath(new URL('..', import.meta.url));

function violations(code: string): string[] {
  const messages = new Linter().verify(code, {
    languageOptions: { ecmaVersion: 2023, sourceType: 'module' },
    rules: determinismRules,
  });
  return messages.map((m) => m.ruleId ?? `fatal: ${m.message}`);
}

describe('sim determinism lint rules', () => {
  it('are wired into the package ESLint config for sim sources and tests', async () => {
    const eslint = new ESLint({ cwd: packageDir });
    for (const file of ['src/sim.ts', 'src/sim.test.ts', 'src/table/pusher.ts']) {
      const config = (await eslint.calculateConfigForFile(file)) as Linter.Config;
      for (const [rule, [, ...options]] of Object.entries(determinismRules)) {
        expect(config.rules?.[rule], `${rule} in ${file}`).toEqual([2, ...options]);
      }
    }
  });

  it.each([
    ['Math.random()', 'no-restricted-properties'],
    ["Math['random']()", 'no-restricted-properties'],
    ['Date.now()', 'no-restricted-globals'],
    ['new Date()', 'no-restricted-globals'],
    ['performance.now()', 'no-restricted-globals'],
    ['crypto.getRandomValues(new Uint32Array(1))', 'no-restricted-globals'],
    ['globalThis.Math.random()', 'no-restricted-globals'],
    ['setTimeout(() => 0, 1)', 'no-restricted-globals'],
    ['Math.sin(1)', 'no-restricted-properties'],
    ['Math.pow(2, 0.5)', 'no-restricted-properties'],
    ['Math.exp(1)', 'no-restricted-properties'],
    ['2 ** 0.5', 'no-restricted-syntax'],
    ['let x = 2; x **= 3', 'no-restricted-syntax'],
    ['const { random } = Math; random()', 'no-restricted-syntax'],
  ])('bans %s', (code, rule) => {
    expect(violations(code)).toContain(rule);
  });

  it('allows the correctly rounded operations the sim relies on', () => {
    expect(
      violations(
        'const a = Math.sqrt(2) * 3 / 4 + 1 - Math.abs(-1); Math.imul(a, 5); Math.fround(a); Math.floor(a); Math.min(a, 1);',
      ),
    ).toEqual([]);
  });

  it('lets benchmarks read a clock', async () => {
    const eslint = new ESLint({ cwd: packageDir });
    const config = (await eslint.calculateConfigForFile('src/step.bench.ts')) as Linter.Config;
    expect(config.rules?.['no-restricted-globals']).toBeUndefined();
  });
});
