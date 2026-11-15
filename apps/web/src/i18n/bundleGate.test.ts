import { describe, expect, it } from 'vitest';
import {
  localeOfChunk,
  localeSources,
  misfiledLocales,
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
