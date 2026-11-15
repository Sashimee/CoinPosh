import { describe, expect, it } from 'vitest';
import { BUNDLE_NEAR, BUNDLE_TOLERANCE } from '../../e2e/budgets.ts';
import {
  budgetReport,
  budgetStatus,
  localeOfChunk,
  localeSources,
  misfiledLocales,
  signedKb,
  type BudgetKey,
  type LocaleSource,
  type Row,
} from '../../e2e/bundle-size.ts';

const sources = localeSources();

function locale(id: string): LocaleSource {
  const found = sources.find(({ language, namespace }) => `${language}/${namespace}` === id);
  if (found === undefined) throw new Error(`no locales/${id}.json`);
  return found;
}

/** The shape rolldown emits for a lazily imported JSON file. */
function dataModule(id: string): string {
  const fields = locale(id).leaves.map((leaf, index) => `k${String(index)}:\`${leaf}\``);
  return `var e={${fields.join(',')}};export{e as default};`;
}

function codeChunk(id: string): string {
  return `import{a as t}from"./i18n-AAAAAAAA.js";var e={${locale(id)
    .leaves.map((leaf, index) => `k${String(index)}:\`${leaf}\``)
    .join(',')}};function n(){return t(e)}export{n as mount};`;
}

function row(key: Row['key'], files: string[]): Row {
  return { key, label: key, files, bytes: 0 };
}

describe('bundle gate locale chunks', () => {
  it('reads a data-only chunk as the locale file it holds', () => {
    expect(
      localeOfChunk('accountUi-account-AAAAAAAA.js', dataModule('fr/account'), sources),
    ).toEqual({ language: 'fr', namespace: 'account' });
  });

  it('still finds a locale chunk under a banner, legal comment or source map line', () => {
    const variants = [
      `${dataModule('de/account')}\n//# sourceMappingURL=account-ZZZZZZZZ.js.map\n`,
      `/*! CoinPosh */\n${dataModule('de/account')}`,
      `${dataModule('de/account')}\n/* built 2026-11-15 */`,
      `//#region locales/de/account.json\n${dataModule('de/account')}\n//#endregion\n`,
    ];
    for (const source of variants) {
      expect(localeOfChunk('account-ZZZZZZZZ.js', source, sources)).toEqual({
        language: 'de',
        namespace: 'account',
      });
    }
  });

  it('fails when a whole locale file sits in a chunk that is not a data module', () => {
    expect(() => localeOfChunk('account-ZZZZZZZZ.js', codeChunk('fr/account'), sources)).toThrow(
      /holds all of locales\/fr\/account\.json but is not a data module/,
    );
  });

  it('leaves a declared static embed in its code chunk', () => {
    expect(localeOfChunk('accountUi-surface-AAAAAAAA.js', codeChunk('en/account'), sources)).toBe(
      undefined,
    );
  });

  it('fails on a data chunk named after a namespace that matches no locale file', () => {
    expect(() =>
      localeOfChunk('fair-AAAAAAAA.js', 'var e={a:`nothing here`};export{e as default};', sources),
    ).toThrow(/looks like a locale chunk/);
  });

  it('ignores code that quotes a few locale strings', () => {
    const [first] = locale('fr/account').leaves;
    expect(
      localeOfChunk('mount-AAAAAAAA.js', `export const a=\`${String(first)}\`;`, sources),
    ).toBe(undefined);
  });
});

describe('bundle gate misfiled locales', () => {
  const files: Record<string, string> = {
    'account-ZZZZZZZZ.js': `${dataModule('fr/account')}\n//# sourceMappingURL=x.map\n`,
    'account-AAAAAAAA.js': 'export const signIn=()=>fetch("/v1/session");',
    'accountUi-surface-AAAAAAAA.js': codeChunk('en/account'),
    'accountUi-account-AAAAAAAA.js': dataModule('de/account'),
  };
  const sourceOf = (file: string): string => {
    const source = files[file];
    if (source === undefined) throw new Error(`unexpected read of ${file}`);
    return source;
  };

  it('flags a locale chunk counted under Account (on tap), whatever its shape', () => {
    expect(
      misfiledLocales(
        [row('accountOnTap', ['account-AAAAAAAA.js', 'account-ZZZZZZZZ.js'])],
        sourceOf,
        sources,
      ),
    ).toEqual([
      'account-ZZZZZZZZ.js holds locales/fr/account.json but is counted under accountOnTap',
    ]);
  });

  it('flags a static embed outside the row it is declared for', () => {
    expect(
      misfiledLocales([row('otherLazyJs', ['accountUi-surface-AAAAAAAA.js'])], sourceOf, sources),
    ).toHaveLength(1);
    expect(
      misfiledLocales([row('accountUi', ['accountUi-surface-AAAAAAAA.js'])], sourceOf, sources),
    ).toEqual([]);
  });

  it('skips the namespace row and files that are not JS chunks', () => {
    expect(
      misfiledLocales(
        [
          row('i18nNamespaces', ['accountUi-account-AAAAAAAA.js']),
          row('wasm', ['rapier_wasm3d_bg-AAAAAAAA.wasm']),
        ],
        sourceOf,
        sources,
      ),
    ).toEqual([]);
  });
});

describe('bundle gate budget status', () => {
  const budget = 10 * 1024;

  it('pins the near share at 90 % and the tolerance at 5 %', () => {
    expect(BUNDLE_NEAR).toBe(0.9);
    expect(BUNDLE_TOLERANCE).toBe(0.05);
  });

  it('reads ok below 90 % of the budget, near from 90 % up to the budget itself', () => {
    expect(budgetStatus(0, budget)).toBe('ok');
    expect(budgetStatus(budget * 0.9 - 1, budget)).toBe('ok');
    expect(budgetStatus(budget * 0.9, budget)).toBe('near');
    expect(budgetStatus(budget - 1, budget)).toBe('near');
    expect(budgetStatus(budget, budget)).toBe('near');
  });

  it('reads over within the tolerance and fails only beyond budget plus tolerance', () => {
    expect(budgetStatus(budget + 1, budget)).toBe('over');
    expect(budgetStatus(budget * 1.05, budget)).toBe('over');
    expect(budgetStatus(budget * 1.05 + 1, budget)).toBe('fail');
  });
});

describe('bundle gate deltas', () => {
  it('signs every delta, in bytes until it shows as 0.1 kB', () => {
    expect(signedKb(0)).toBe('±0 B');
    expect(signedKb(12)).toBe('+12 B');
    expect(signedKb(-51)).toBe('-51 B');
    expect(signedKb(52)).toBe('+0.1 kB');
    expect(signedKb(1536)).toBe('+1.5 kB');
    expect(signedKb(-2048)).toBe('-2.0 kB');
  });
});

describe('bundle gate report', () => {
  const budgets = {
    initialJs: 100 * 1024,
    safesDock: 10 * 1024,
    safesSheet: 10 * 1024,
    gachaDock: 10 * 1024,
    fonts: 10 * 1024,
  } as Record<BudgetKey, number>;

  function sized(key: BudgetKey, kB: number, files = [`${key}-AAAAAAAA.js`]): Row {
    return { key, label: key, files, bytes: Math.round(kB * 1024) };
  }

  const head = [
    sized('initialJs', 50),
    sized('safesDock', 9.5),
    sized('safesSheet', 10.4),
    sized('gachaDock', 10.6),
    sized('fonts', 8.9),
  ];

  function rowLine(lines: readonly string[], key: string): string {
    const line = lines.find((candidate) => candidate.startsWith(`| ${key} |`));
    if (line === undefined) throw new Error(`no table row for ${key}`);
    return line;
  }

  it('prints near for every row at 90 % or more and fails only above budget plus tolerance', () => {
    const { lines, failures, warnings } = budgetReport(head, budgets);
    expect(rowLine(lines, 'initialJs')).toContain('| 50.0 % | ok |');
    expect(rowLine(lines, 'fonts')).toContain('| 89.0 % | ok |');
    expect(rowLine(lines, 'safesDock')).toContain('| 95.0 % | near, 0.5 kB left |');
    expect(rowLine(lines, 'safesSheet')).toContain('| over, within tolerance |');
    expect(rowLine(lines, 'gachaDock')).toContain('| FAIL |');
    expect(failures).toEqual(['gachaDock is 10.6 kB, budget 10.0 kB']);
    expect(lines).toContain(
      'At 90 % of budget or more (3): safesDock 95.0 %, safesSheet 104.0 %, gachaDock 106.0 %.',
    );
    expect(lines.some((line) => line.includes('Δ'))).toBe(false);
    expect(warnings).toEqual([]);
  });

  it('adds a signed per-row delta against the base build, and new for a row the base lacks', () => {
    const base = {
      label: 'abc1234',
      rows: [
        sized('initialJs', 51),
        sized('safesDock', 8.5),
        sized('safesSheet', 10.4),
        sized('gachaDock', 0, []),
        sized('fonts', 8.9),
      ],
    };
    const { lines, failures, warnings } = budgetReport(head, budgets, base);
    expect(lines).toContain('| Bundle | Size | Δ abc1234 | Budget | Used | Status | Files |');
    expect(rowLine(lines, 'initialJs')).toContain('| 50.0 kB | -1.0 kB | 100.0 kB |');
    expect(rowLine(lines, 'safesDock')).toContain('| 9.5 kB | +1.0 kB | 10.0 kB |');
    expect(rowLine(lines, 'safesSheet')).toContain('| 10.4 kB | ±0 B | 10.0 kB |');
    expect(rowLine(lines, 'gachaDock')).toContain('| 10.6 kB | new | 10.0 kB |');
    expect(lines).toContain('Grew against abc1234: safesDock +1.0 kB (now 95.0 %).');
    expect(warnings).toEqual([
      'safesDock grew +1.0 kB against abc1234 to 9.5 kB, 95.0 % of its 10.0 kB budget',
    ]);
    expect(failures).toEqual(['gachaDock is 10.6 kB, budget 10.0 kB']);
  });

  it('keeps byte-level noise out of the growth summary', () => {
    const base = { label: 'abc1234', rows: head.map((row) => ({ ...row, bytes: row.bytes - 20 })) };
    const { lines, warnings } = budgetReport(head, budgets, base);
    expect(rowLine(lines, 'safesDock')).toContain('| +20 B |');
    expect(lines).toContain('No row grew by 0.1 kB or more against abc1234.');
    expect(warnings).toEqual([]);
  });
});
