import { appendFileSync, existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';
import { localeFile, type LocaleFile } from '../src/i18n/core.ts';
import { BUNDLE_BUDGETS, BUNDLE_TOLERANCE } from './budgets.ts';
import { APP_DIR } from './env.ts';

/**
 * P-124 bundle gate over apps/web/dist: gzip sizes against BUNDLE_BUDGETS, failing when one is
 * exceeded by more than BUNDLE_TOLERANCE, and failing when the three.webgpu chunk is reachable
 * from index.html without a dynamic import. Run after `pnpm build`.
 */

const DIST = join(APP_DIR, 'dist');
const LOCALES = join(APP_DIR, 'src', 'i18n', 'locales');
const ASSETS = join(DIST, 'assets');
const FONTS = join(DIST, 'fonts');
const BASE = '/';
const WASM_BASE64 = /["'`](AGFzbQ[A-Za-z0-9+/=]+)["'`]/g;
const STATIC_IMPORT = /\bimport\s*(?:[\w$\s{},*]+?\s*from\s*)?["']\.\/([\w.-]+\.js)["']/g;
const STATIC_REEXPORT = /\bexport\s*(?:\*|\{[^}]*\})\s*from\s*["']\.\/([\w.-]+\.js)["']/g;

/**
 * T-10.03: the account client and its Demo mock, loaded on the first tap of a sign-in button.
 * Measured at 7.1 kB gzip (3.1 + 4.0) on 2026-11-13; kept out of Other lazy JS so account
 * growth cannot eat the table's headroom, and failed outright if it reaches the initial load.
 */
const ACCOUNT_ON_TAP_BUDGET = 7.5 * 1024;
const ACCOUNT_CHUNK = /^account-[\w-]+\.js$/;
/** Named by vite.config.ts chunkFileName: every chunk built only from ui/account and its strings. */
const ACCOUNT_UI_CHUNK = /^accountUi-[\w-]+\.js$/;
const SAFES_DOCK_CHUNK = /^safes-[\w-]+\.js$/;
const SAFES_SHEET_CHUNK = /^safesSheet-[\w-]+\.js$/;
/**
 * The dynamic entries main.ts awaits before the stage draws: the renderer, the Riviera venue and
 * the sim bridge, with every lazy chunk they statically pull in (coins, emboss, geometry, look).
 */
const STAGE_ENTRIES = ['stage', 'riviera', 'simWorker'] as const;
/** Imported beside the stage but first used once the table is up: crates, vfx and game systems. */
const POST_TABLE_ENTRIES = ['crates', 'vfx', 'systems'] as const;
/**
 * A locale file emitted as its own chunk: one minified object and its default export, wrapped in
 * a namespace object when a file is both statically and dynamically imported (EN account). Named
 * after the namespace (`fair-*`, `account-*`, `accountUi-account-*`), so the name alone cannot
 * tell it from code; the gate matches the content against locales/<language>/<ns>.json instead.
 */
const DATA_MODULE =
  /^(?:import\{[\w$]+ as [\w$]+\}from"\.\/rolldown-runtime-[\w-]+\.js";)?var [\w$]+=(?:[\w$]+\(\{default:\(\)=>[\w$]+\}\),[\w$]+=)?\{[\s\S]*\};export\{[^}]*\};?$/;
/** Banners, legal comments and `//# sourceMappingURL` lines a build setting can add to a chunk. */
const LEADING_BLOCK_COMMENT = /^\/\*[\s\S]*?\*\/\s*/;
const TRAILING_BLOCK_COMMENT = /\s*\/\*(?:(?!\*\/)[\s\S])*\*\/$/;
const LINE_COMMENT = /^[ \t]*\/\/.*$/gm;
/** Characters the minifier escapes in a string, including French no-break spaces before `:`. */
const ESCAPED_IN_OUTPUT = /[`\\]|\$\{|[^\S ]|[\p{Cc}\p{Cf}]/u;
/**
 * Locale files a feature imports statically as its first-paint fallback, so they ship inside that
 * feature's code chunk; the row named here is the only one allowed to hold them. The Certified
 * Fair desk (ui/fair/i18n.ts) still imports all three of its locale files.
 */
const STATIC_LOCALE_EMBEDS: Readonly<Record<string, BudgetKey>> = {
  'en/account': 'accountUi',
  'en/fair': 'fairPanel',
  'fr/fair': 'fairPanel',
  'de/fair': 'fairPanel',
};
const GACHA_DOCK_CHUNK = /^gacha-[\w-]+\.js$/;
const GACHA_SHEET_CHUNK = /^gacha(?:Sheet|Odds)-[\w-]+\.js$/;

/**
 * P-641: the reward sheets main.ts imports on their first tap, each chunk named after its
 * folder's index.ts. Every one has its own row, so none can grow into Other lazy JS. Matched
 * among code chunks only: the `fair-*` locale chunks belong to the i18n namespaces row.
 */
const ON_TAP_SURFACES = [
  { key: 'inventorySheet', label: 'Collection sheet (on tap)', chunk: /^inventory-[\w-]+\.js$/ },
  { key: 'albumSheet', label: 'Album (on tap)', chunk: /^album-[\w-]+\.js$/ },
  { key: 'fairPanel', label: 'Certified Fair (on tap)', chunk: /^fair-[\w-]+\.js$/ },
  {
    key: 'scratchCards',
    label: 'Scratch Cards (on tap)',
    chunk: /^scratch(?:Sheet|Foil)?-[\w-]+\.js$/,
  },
] as const satisfies readonly {
  readonly key: keyof typeof BUNDLE_BUDGETS;
  readonly label: string;
  readonly chunk: RegExp;
}[];

export type BudgetKey = keyof typeof BUNDLE_BUDGETS | 'accountOnTap';

export interface LocaleSource extends LocaleFile {
  /** Leaf strings a minifier prints verbatim inside a template literal. */
  readonly leaves: readonly string[];
}

interface LocaleChunk extends LocaleFile {
  readonly file: string;
}

const BUDGETS: Record<BudgetKey, number> = {
  ...BUNDLE_BUDGETS,
  accountOnTap: ACCOUNT_ON_TAP_BUDGET,
};

export interface Row {
  readonly key: BudgetKey;
  readonly label: string;
  readonly files: readonly string[];
  readonly bytes: number;
}

interface Measured {
  readonly rows: Row[];
  readonly lazyThree: boolean;
  readonly eagerAccount: readonly string[];
  readonly eagerAccountUi: readonly string[];
  readonly eagerSafes: readonly string[];
  readonly eagerGacha: readonly string[];
  readonly eagerSurfaces: readonly string[];
  readonly initial: readonly string[];
  readonly locales: ReadonlyMap<string, LocaleChunk>;
}

function fail(message: string): never {
  throw new Error(`bundle-size: ${message}`);
}

function gzipBytes(data: string | Buffer): number {
  return gzipSync(data, { level: 9 }).length;
}

function read(file: string): string {
  return readFileSync(join(ASSETS, file), 'utf8');
}

function entryScripts(): string[] {
  const htmlPath = join(DIST, 'index.html');
  if (!existsSync(htmlPath)) fail(`${htmlPath} is missing; run \`pnpm build\` first`);
  const html = readFileSync(htmlPath, 'utf8');
  const refs = [
    ...html.matchAll(/<script[^>]+type="module"[^>]*\ssrc="([^"]+)"/g),
    ...html.matchAll(/<link[^>]+rel="modulepreload"[^>]*\shref="([^"]+)"/g),
  ].map((match) => match[1] ?? '');
  const files = refs.map((ref) => {
    const prefix = `${BASE}assets/`;
    if (!ref.startsWith(prefix)) fail(`index.html loads ${ref}, outside ${prefix}`);
    return ref.slice(prefix.length);
  });
  if (files.length === 0) fail('index.html loads no module script');
  return files;
}

function staticClosure(entries: readonly string[]): Set<string> {
  const seen = new Set<string>();
  const queue = [...entries];
  for (let file = queue.pop(); file !== undefined; file = queue.pop()) {
    if (seen.has(file)) continue;
    seen.add(file);
    const source = read(file);
    for (const pattern of [STATIC_IMPORT, STATIC_REEXPORT]) {
      for (const match of source.matchAll(pattern)) {
        if (match[1]) queue.push(match[1]);
      }
    }
  }
  return seen;
}

function sum(files: readonly string[], size: (file: string) => number): number {
  return files.reduce((total, file) => total + size(file), 0);
}

function leafStrings(tree: unknown): string[] {
  if (typeof tree === 'string') return [tree];
  if (tree === null || typeof tree !== 'object') return [];
  return Object.values(tree).flatMap(leafStrings);
}

/** Every on-demand namespace file (all but the bundled ui.json), with its searchable strings. */
export function localeSources(): LocaleSource[] {
  const sources: LocaleSource[] = [];
  for (const language of readdirSync(LOCALES)) {
    for (const file of readdirSync(join(LOCALES, language))) {
      if (!file.endsWith('.json') || file === 'ui.json') continue;
      const tree: unknown = JSON.parse(readFileSync(join(LOCALES, language, file), 'utf8'));
      const leaves = leafStrings(tree).filter((leaf) => !ESCAPED_IN_OUTPUT.test(leaf));
      if (leaves.length === 0) fail(`locales/${language}/${file} has no string the gate can match`);
      sources.push({ ...localeFile(`locales/${language}/${file}`), leaves });
    }
  }
  if (sources.length === 0) fail(`no namespace locale files under ${LOCALES}; update the gate`);
  return sources;
}

function localeId({ language, namespace }: LocaleFile): string {
  return `${language}/${namespace}`;
}

/** The locale files whose every matchable string appears in the chunk source. */
export function heldLocales(
  source: string,
  sources: readonly LocaleSource[],
): readonly LocaleSource[] {
  return sources.filter(({ leaves }) => leaves.every((leaf) => source.includes(leaf)));
}

export function isDataModule(source: string): boolean {
  let code = source.replace(LINE_COMMENT, '').trim();
  for (let previous = ''; previous !== code;) {
    previous = code;
    code = code.replace(LEADING_BLOCK_COMMENT, '').replace(TRAILING_BLOCK_COMMENT, '').trim();
  }
  return DATA_MODULE.test(code);
}

/**
 * The locale file a lazy chunk holds as data, or undefined for a code chunk. Every chunk is
 * content-matched whatever its shape: one holding a whole locale file that is neither a data
 * module nor a declared static embed fails the gate, so a build change cannot drop locale bytes
 * into a code row unnoticed.
 */
export function localeOfChunk(
  file: string,
  source: string,
  sources: readonly LocaleSource[],
): LocaleFile | undefined {
  const matches = heldLocales(source, sources);
  const data = isDataModule(source);
  if (
    !data &&
    matches.length > 0 &&
    matches.every((match) => STATIC_LOCALE_EMBEDS[localeId(match)] !== undefined)
  ) {
    return undefined;
  }
  if (matches.length > 1) {
    fail(
      `${file} matches ${matches.map((match) => `${localeId(match)}.json`).join(' and ')}; update the gate`,
    );
  }
  const [match] = matches;
  if (match === undefined) {
    const namespaces = new Set(sources.map((locale) => locale.namespace));
    if (data && file.split('-').some((part) => namespaces.has(part))) {
      fail(`${file} looks like a locale chunk but matches no locales/<language>/<ns>.json`);
    }
    return undefined;
  }
  if (data) return { language: match.language, namespace: match.namespace };
  if (STATIC_LOCALE_EMBEDS[localeId(match)] !== undefined) return undefined;
  fail(
    `${file} holds all of locales/${localeId(match)}.json but is not a data module: the locale chunk shape changed or code bundles it statically; update DATA_MODULE or STATIC_LOCALE_EMBEDS`,
  );
}

/** The lazy chunks that hold exactly one namespace locale file. */
function localeChunks(lazy: readonly string[]): Map<string, LocaleChunk> {
  const sources = localeSources();
  const chunks = new Map<string, LocaleChunk>();
  for (const file of lazy) {
    const locale = localeOfChunk(file, read(file), sources);
    if (locale !== undefined) chunks.set(file, { file, ...locale });
  }
  return chunks;
}

/**
 * Re-reads every JS file a row other than the namespace row counts and reports each that holds a
 * whole locale file outside the row STATIC_LOCALE_EMBEDS allows, independently of how the
 * namespace row was built.
 */
export function misfiledLocales(
  rows: readonly Row[],
  sourceOf: (file: string) => string,
  sources: readonly LocaleSource[],
): string[] {
  return rows.flatMap((row) =>
    row.key === 'i18nNamespaces'
      ? []
      : row.files
          .filter((file) => file.endsWith('.js'))
          .flatMap((file) =>
            heldLocales(sourceOf(file), sources)
              .filter((locale) => STATIC_LOCALE_EMBEDS[localeId(locale)] !== row.key)
              .map(
                (locale) =>
                  `${file} holds locales/${localeId(locale)}.json but is counted under ${row.label}`,
              ),
          ),
  );
}

/** What one player downloads at most: one translation of every namespace, the largest. */
function namespaceBytes(chunks: Iterable<LocaleChunk>, size: (file: string) => number): number {
  const largest = new Map<string, number>();
  for (const { file, namespace } of chunks) {
    largest.set(namespace, Math.max(largest.get(namespace) ?? 0, size(file)));
  }
  return [...largest.values()].reduce((total, bytes) => total + bytes, 0);
}

function entryChunk(js: readonly string[], name: string): string {
  const pattern = new RegExp(`^${name}-[\\w-]{8}\\.js$`);
  const found = js.filter((file) => pattern.test(file));
  if (found.length !== 1) {
    fail(
      `expected one ${name}-<hash>.js chunk in dist/assets, found ${String(found.length)}; update the gate`,
    );
  }
  return found[0] ?? '';
}

/** The lazy chunks the named entries load, apart from ones a row already counts. */
function lazyClosure(
  js: readonly string[],
  names: readonly string[],
  accounted: ReadonlySet<string>,
): string[] {
  const closure = staticClosure(names.map((name) => entryChunk(js, name)));
  return [...closure].filter((file) => !accounted.has(file)).sort();
}

function measure(): Measured {
  const js = readdirSync(ASSETS).filter((file) => file.endsWith('.js'));
  const initial = [...staticClosure(entryScripts())];
  const three = js.filter((file) => file.startsWith('three.webgpu-'));
  if (three.length === 0) fail('no three.webgpu-*.js chunk in dist/assets; update the gate');
  const workers = js.filter((file) => /\.worker-[\w-]+\.js$/.test(file));
  if (workers.length === 0) fail('no *.worker-*.js chunk in dist/assets; update the gate');
  const locales = localeChunks(js.filter((file) => !initial.includes(file)));
  const code = js.filter((file) => !locales.has(file));
  const account = code.filter((file) => ACCOUNT_CHUNK.test(file));
  if (account.length === 0) fail('no account-*.js chunk in dist/assets; update the gate');
  const accountUi = code.filter((file) => ACCOUNT_UI_CHUNK.test(file));
  if (accountUi.length === 0) fail('no accountUi-*.js chunk in dist/assets; update the gate');
  const safesDock = js.filter((file) => SAFES_DOCK_CHUNK.test(file));
  if (safesDock.length === 0) fail('no safes-*.js chunk in dist/assets; update the gate');
  const safesSheet = js.filter((file) => SAFES_SHEET_CHUNK.test(file));
  if (safesSheet.length === 0) fail('no safesSheet-*.js chunk in dist/assets; update the gate');
  const gachaDock = js.filter((file) => GACHA_DOCK_CHUNK.test(file));
  if (gachaDock.length === 0) fail('no gacha-*.js chunk in dist/assets; update the gate');
  const gachaSheet = js.filter((file) => GACHA_SHEET_CHUNK.test(file));
  if (gachaSheet.length < 2) {
    fail('no gachaSheet-*.js and gachaOdds-*.js chunks in dist/assets; update the gate');
  }
  const surfaces = ON_TAP_SURFACES.map((surface) => {
    const files = code.filter((file) => surface.chunk.test(file));
    if (files.length === 0) {
      fail(
        `no ${String(surface.chunk)} chunk for ${surface.label} in dist/assets; update the gate`,
      );
    }
    return { ...surface, files };
  });

  let wasmBytes = 0;
  const wasmFiles: string[] = readdirSync(ASSETS).filter((file) => file.endsWith('.wasm'));
  for (const file of wasmFiles) wasmBytes += gzipBytes(readFileSync(join(ASSETS, file)));
  let workerBytes = 0;
  for (const file of workers) {
    const source = read(file);
    let inlined = '';
    const stripped = source.replace(WASM_BASE64, (_match, base64: string) => {
      inlined += base64;
      return '""';
    });
    if (inlined !== '') {
      wasmBytes += gzipBytes(inlined);
      wasmFiles.push(
        `${file} (inlined base64; ${kb(gzipBytes(Buffer.from(inlined, 'base64')))} as a .wasm asset)`,
      );
    }
    workerBytes += gzipBytes(stripped);
  }
  if (wasmFiles.length === 0) fail('found no Rapier wasm, inlined or as a .wasm asset');

  const fonts = existsSync(FONTS)
    ? readdirSync(FONTS).filter((file) => file.endsWith('.woff2'))
    : [];
  if (fonts.length === 0) fail('no fonts/*.woff2 in dist; update the gate');

  const gz = (file: string): number => gzipBytes(read(file));
  const accounted = new Set([
    ...initial,
    ...three,
    ...workers,
    ...locales.keys(),
    ...account,
    ...accountUi,
    ...safesDock,
    ...safesSheet,
    ...gachaDock,
    ...gachaSheet,
    ...surfaces.flatMap((surface) => surface.files),
  ]);
  const stageLazy = lazyClosure(js, STAGE_ENTRIES, accounted);
  for (const file of stageLazy) accounted.add(file);
  const postTableLazy = lazyClosure(js, POST_TABLE_ENTRIES, accounted);
  for (const file of postTableLazy) accounted.add(file);
  const otherLazy = js.filter((file) => !accounted.has(file));
  const localeFiles = [...locales.values()]
    .sort((a, b) => `${a.namespace}/${a.language}`.localeCompare(`${b.namespace}/${b.language}`))
    .map(({ file, language, namespace }) => `${file} (${language}/${namespace})`);
  const rows: Row[] = [
    { key: 'initialJs', label: 'Initial JS', files: initial, bytes: sum(initial, gz) },
    { key: 'threeChunk', label: 'three.webgpu (lazy)', files: three, bytes: sum(three, gz) },
    { key: 'workerJs', label: 'Sim worker JS', files: workers, bytes: workerBytes },
    { key: 'wasm', label: 'Rapier wasm', files: wasmFiles, bytes: wasmBytes },
    {
      key: 'stageLazyJs',
      label: 'Boot lazy: stage, venue & sim',
      files: stageLazy,
      bytes: sum(stageLazy, gz),
    },
    {
      key: 'postTableLazyJs',
      label: 'Boot lazy: crates, vfx & systems (post-table)',
      files: postTableLazy,
      bytes: sum(postTableLazy, gz),
    },
    { key: 'otherLazyJs', label: 'Other lazy JS', files: otherLazy, bytes: sum(otherLazy, gz) },
    {
      key: 'i18nNamespaces',
      label: 'i18n namespaces (one locale, on demand)',
      files: localeFiles,
      bytes: namespaceBytes(locales.values(), gz),
    },
    { key: 'accountOnTap', label: 'Account (on tap)', files: account, bytes: sum(account, gz) },
    {
      key: 'accountUi',
      label: 'Account UI (post-boot)',
      files: accountUi,
      bytes: sum(accountUi, gz),
    },
    {
      key: 'safesDock',
      label: 'Safes dock (after boot)',
      files: safesDock,
      bytes: sum(safesDock, gz),
    },
    {
      key: 'safesSheet',
      label: 'Safes sheet (on tap)',
      files: safesSheet,
      bytes: sum(safesSheet, gz),
    },
    {
      key: 'gachaDock',
      label: 'Capsules dock (after boot)',
      files: gachaDock,
      bytes: sum(gachaDock, gz),
    },
    {
      key: 'gachaSheet',
      label: 'Capsules sheet and odds (on tap)',
      files: gachaSheet,
      bytes: sum(gachaSheet, gz),
    },
    ...surfaces.map(({ key, label, files }) => ({ key, label, files, bytes: sum(files, gz) })),
    {
      key: 'fonts',
      label: 'Webfonts (woff2 as served)',
      files: fonts,
      bytes: sum(fonts, (file) => statSync(join(FONTS, file)).size),
    },
  ];
  return {
    rows,
    lazyThree: !three.some((file) => initial.includes(file)),
    eagerAccount: account.filter((file) => initial.includes(file)),
    eagerAccountUi: accountUi.filter((file) => initial.includes(file)),
    eagerSafes: [...safesDock, ...safesSheet].filter((file) => initial.includes(file)),
    eagerGacha: [...gachaDock, ...gachaSheet].filter((file) => initial.includes(file)),
    eagerSurfaces: surfaces
      .flatMap((surface) => surface.files)
      .filter((file) => initial.includes(file)),
    initial,
    locales,
  };
}

function kb(bytes: number): string {
  return `${(bytes / 1024).toFixed(1)} kB`;
}

function main(): void {
  const {
    rows,
    lazyThree,
    eagerAccount,
    eagerAccountUi,
    eagerSafes,
    eagerGacha,
    eagerSurfaces,
    initial,
    locales,
  } = measure();
  const lines = [
    '### Bundle budgets (gzip)',
    '',
    `Fails above budget + ${String(BUNDLE_TOLERANCE * 100)} %.`,
    '',
    '| Bundle | Size | Budget | Used | Status | Files |',
    '| --- | ---: | ---: | ---: | --- | --- |',
  ];
  const failures: string[] = [];
  for (const row of rows) {
    const budget = BUDGETS[row.key];
    const used = row.bytes / budget;
    const over = used > 1 + BUNDLE_TOLERANCE;
    const status = over ? 'FAIL' : used > 1 ? 'over, within tolerance' : 'ok';
    if (over) failures.push(`${row.label} is ${kb(row.bytes)}, budget ${kb(budget)}`);
    lines.push(
      `| ${row.label} | ${kb(row.bytes)} | ${kb(budget)} | ${(used * 100).toFixed(0)} % | ${status} | ${row.files.join(', ')} |`,
    );
  }
  lines.push(
    '',
    lazyThree
      ? 'three.webgpu is lazy: no static import reaches it from index.html.'
      : `FAIL: three.webgpu is in the initial load (${initial.join(', ')}).`,
  );
  if (!lazyThree) failures.push('three.webgpu is statically reachable from index.html');
  lines.push(
    eagerAccount.length === 0
      ? 'The account chunks are lazy: they load on the first sign-in tap.'
      : `FAIL: account code is in the initial load (${eagerAccount.join(', ')}).`,
  );
  if (eagerAccount.length > 0)
    failures.push('account code is statically reachable from index.html');
  lines.push(
    eagerAccountUi.length === 0
      ? 'The account UI chunks are lazy: the prompt clock loads after boot, the section on first need.'
      : `FAIL: account UI code is in the initial load (${eagerAccountUi.join(', ')}).`,
  );
  if (eagerAccountUi.length > 0) {
    failures.push('account UI code is statically reachable from index.html');
  }
  lines.push(
    eagerSafes.length === 0
      ? 'The safes chunks are lazy: the dock loads after the table, the sheet on the first press.'
      : `FAIL: safes code is in the initial load (${eagerSafes.join(', ')}).`,
  );
  if (eagerSafes.length > 0) failures.push('safes code is statically reachable from index.html');
  lines.push(
    eagerGacha.length === 0
      ? 'The capsule chunks are lazy: the dock loads after the table, the sheet on the first press.'
      : `FAIL: capsule code is in the initial load (${eagerGacha.join(', ')}).`,
  );
  if (eagerGacha.length > 0) failures.push('capsule code is statically reachable from index.html');
  lines.push(
    eagerSurfaces.length === 0
      ? 'The Collection, Album, Certified Fair and Scratch Cards chunks are lazy: each loads on its first tap.'
      : `FAIL: reward sheet code is in the initial load (${eagerSurfaces.join(', ')}).`,
  );
  if (eagerSurfaces.length > 0) {
    failures.push('reward sheet code is statically reachable from index.html');
  }
  const misfiled = misfiledLocales(rows, read, localeSources());
  lines.push(
    misfiled.length === 0
      ? `Locale chunks count once, in the i18n namespaces row (${String(locales.size)} found): no code row, Account (on tap) included, holds a whole locale file.`
      : `FAIL: ${misfiled.join('; ')}.`,
  );
  failures.push(...misfiled);

  const report = `${lines.join('\n')}\n`;
  const summary = process.env.GITHUB_STEP_SUMMARY;
  if (summary) appendFileSync(summary, report);
  process.stdout.write(report);
  if (failures.length > 0) {
    process.stderr.write(`\nbundle-size: over budget:\n- ${failures.join('\n- ')}\n`);
    process.exitCode = 1;
  }
}

if (import.meta.main) main();
