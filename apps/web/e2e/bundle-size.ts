import { execFileSync, spawnSync } from 'node:child_process';
import {
  appendFileSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';
import { localeFile, type LocaleFile } from '../src/i18n/core.ts';
import { BUNDLE_BUDGETS, BUNDLE_NEAR, BUNDLE_TOLERANCE } from './budgets.ts';
import { APP_DIR } from './env.ts';

/**
 * P-124 bundle gate over apps/web/dist: gzip sizes against BUNDLE_BUDGETS, failing when one is
 * exceeded by more than BUNDLE_TOLERANCE, and failing when the three.webgpu chunk is reachable
 * from index.html without a dynamic import. Run after `pnpm build`.
 *
 * P-728: a row at BUNDLE_NEAR of its budget or more reads 'near'. With BASE_SHA set (perf.yml
 * passes the commit a PR merges into), the gate also builds that commit in a temporary git
 * worktree and prints a signed per-row delta, so a reviewer sees which change spends a row's
 * headroom before the row fails.
 */

const LOCALES = join(APP_DIR, 'src', 'i18n', 'locales');
const BASE = '/';
const WASM_BASE64 = /["'`](AGFzbQ[A-Za-z0-9+/=]+)["'`]/g;
const STATIC_IMPORT = /\bimport\s*(?:[\w$\s{},*]+?\s*from\s*)?["']\.\/([\w.-]+\.js)["']/g;
const STATIC_REEXPORT = /\bexport\s*(?:\*|\{[^}]*\})\s*from\s*["']\.\/([\w.-]+\.js)["']/g;
const COMMIT_SHA = /^[0-9a-f]{7,40}$/i;
/**
 * Growth below what rounds to 0.1 kB stays out of the summary and annotations: a gzip size moves
 * by a few bytes with unrelated edits (chunk hashes in import paths, module order).
 */
const NOTABLE_DELTA_BYTES = 0.05 * 1024;

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
 * feature's code chunk; the row named here is the only one allowed to hold them.
 */
const STATIC_LOCALE_EMBEDS: Readonly<Record<string, BudgetKey>> = { 'en/account': 'accountUi' };
const GACHA_DOCK_CHUNK = /^gacha-[\w-]+\.js$/;
const GACHA_SHEET_CHUNK = /^gacha(?:Sheet|Odds)-[\w-]+\.js$/;

export type BudgetKey = keyof typeof BUNDLE_BUDGETS | 'accountOnTap';

export interface LocaleSource extends LocaleFile {
  /** Leaf strings a minifier prints verbatim inside a template literal. */
  readonly leaves: readonly string[];
}

interface LocaleChunk extends LocaleFile {
  readonly file: string;
}

/** A Vite build to measure and the locale sources it was built from. */
interface Build {
  readonly dist: string;
  readonly locales: string;
  /**
   * False for the merge-base build only: a chunk group the base predates measures as an empty
   * row, shown as 'new', instead of failing. The build under test is always strict.
   */
  readonly strict: boolean;
}

const HEAD_BUILD: Build = { dist: join(APP_DIR, 'dist'), locales: LOCALES, strict: true };

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

/** The merge-base measurement the table diffs against. */
export interface BaseRows {
  /** The short commit sha shown in the report. */
  readonly label: string;
  readonly rows: readonly Row[];
}

export type BudgetStatus = 'ok' | 'near' | 'over' | 'fail';

export interface BudgetReport {
  readonly lines: readonly string[];
  readonly failures: readonly string[];
  /** One line each for a CI annotation: rows that are near or over budget and grew. */
  readonly warnings: readonly string[];
}

interface Measured {
  readonly rows: Row[];
  readonly lazyThree: boolean;
  readonly eagerAccount: readonly string[];
  readonly eagerAccountUi: readonly string[];
  readonly eagerSafes: readonly string[];
  readonly eagerGacha: readonly string[];
  readonly initial: readonly string[];
  readonly locales: ReadonlyMap<string, LocaleChunk>;
}

function fail(message: string): never {
  throw new Error(`bundle-size: ${message}`);
}

/** Fails a missing chunk group on the build under test; the merge-base build may predate it. */
function expectGroup(build: Build, present: boolean, message: string): void {
  if (!present && build.strict) fail(message);
}

function gzipBytes(data: string | Buffer): number {
  return gzipSync(data, { level: 9 }).length;
}

function assetsOf(build: Build): string {
  return join(build.dist, 'assets');
}

function reader(build: Build): (file: string) => string {
  const assets = assetsOf(build);
  return (file) => readFileSync(join(assets, file), 'utf8');
}

function entryScripts(build: Build): string[] {
  const htmlPath = join(build.dist, 'index.html');
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

function staticClosure(entries: readonly string[], read: (file: string) => string): Set<string> {
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
export function localeSources(locales: string = LOCALES): LocaleSource[] {
  const sources: LocaleSource[] = [];
  for (const language of readdirSync(locales)) {
    for (const file of readdirSync(join(locales, language))) {
      if (!file.endsWith('.json') || file === 'ui.json') continue;
      const tree: unknown = JSON.parse(readFileSync(join(locales, language, file), 'utf8'));
      const leaves = leafStrings(tree).filter((leaf) => !ESCAPED_IN_OUTPUT.test(leaf));
      if (leaves.length === 0) fail(`locales/${language}/${file} has no string the gate can match`);
      sources.push({ ...localeFile(`locales/${language}/${file}`), leaves });
    }
  }
  if (sources.length === 0) fail(`no namespace locale files under ${locales}; update the gate`);
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
  if (matches.length > 1) {
    fail(
      `${file} matches ${matches.map((match) => `${localeId(match)}.json`).join(' and ')}; update the gate`,
    );
  }
  const data = isDataModule(source);
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
function localeChunks(build: Build, lazy: readonly string[]): Map<string, LocaleChunk> {
  const sources = localeSources(build.locales);
  const read = reader(build);
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

function entryChunk(build: Build, js: readonly string[], name: string): string | undefined {
  const pattern = new RegExp(`^${name}-[\\w-]{8}\\.js$`);
  const found = js.filter((file) => pattern.test(file));
  if (found.length > 1 || (found.length === 0 && build.strict)) {
    fail(
      `expected one ${name}-<hash>.js chunk in dist/assets, found ${String(found.length)}; update the gate`,
    );
  }
  return found[0];
}

/** The lazy chunks the named entries load, apart from ones a row already counts. */
function lazyClosure(
  build: Build,
  js: readonly string[],
  names: readonly string[],
  accounted: ReadonlySet<string>,
): string[] {
  const entries = names.flatMap((name) => entryChunk(build, js, name) ?? []);
  const closure = staticClosure(entries, reader(build));
  return [...closure].filter((file) => !accounted.has(file)).sort();
}

function measure(build: Build): Measured {
  const assets = assetsOf(build);
  const fontsDir = join(build.dist, 'fonts');
  const read = reader(build);
  const js = readdirSync(assets).filter((file) => file.endsWith('.js'));
  const initial = [...staticClosure(entryScripts(build), read)];
  const three = js.filter((file) => file.startsWith('three.webgpu-'));
  expectGroup(
    build,
    three.length > 0,
    'no three.webgpu-*.js chunk in dist/assets; update the gate',
  );
  const workers = js.filter((file) => /\.worker-[\w-]+\.js$/.test(file));
  expectGroup(build, workers.length > 0, 'no *.worker-*.js chunk in dist/assets; update the gate');
  const locales = localeChunks(
    build,
    js.filter((file) => !initial.includes(file)),
  );
  const code = js.filter((file) => !locales.has(file));
  const account = code.filter((file) => ACCOUNT_CHUNK.test(file));
  expectGroup(build, account.length > 0, 'no account-*.js chunk in dist/assets; update the gate');
  const accountUi = code.filter((file) => ACCOUNT_UI_CHUNK.test(file));
  expectGroup(
    build,
    accountUi.length > 0,
    'no accountUi-*.js chunk in dist/assets; update the gate',
  );
  const safesDock = js.filter((file) => SAFES_DOCK_CHUNK.test(file));
  expectGroup(build, safesDock.length > 0, 'no safes-*.js chunk in dist/assets; update the gate');
  const safesSheet = js.filter((file) => SAFES_SHEET_CHUNK.test(file));
  expectGroup(
    build,
    safesSheet.length > 0,
    'no safesSheet-*.js chunk in dist/assets; update the gate',
  );
  const gachaDock = js.filter((file) => GACHA_DOCK_CHUNK.test(file));
  expectGroup(build, gachaDock.length > 0, 'no gacha-*.js chunk in dist/assets; update the gate');
  const gachaSheet = js.filter((file) => GACHA_SHEET_CHUNK.test(file));
  expectGroup(
    build,
    gachaSheet.length >= 2,
    'no gachaSheet-*.js and gachaOdds-*.js chunks in dist/assets; update the gate',
  );

  let wasmBytes = 0;
  const wasmFiles: string[] = readdirSync(assets).filter((file) => file.endsWith('.wasm'));
  for (const file of wasmFiles) wasmBytes += gzipBytes(readFileSync(join(assets, file)));
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
  expectGroup(build, wasmFiles.length > 0, 'found no Rapier wasm, inlined or as a .wasm asset');

  const fonts = existsSync(fontsDir)
    ? readdirSync(fontsDir).filter((file) => file.endsWith('.woff2'))
    : [];
  expectGroup(build, fonts.length > 0, 'no fonts/*.woff2 in dist; update the gate');

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
  ]);
  const stageLazy = lazyClosure(build, js, STAGE_ENTRIES, accounted);
  for (const file of stageLazy) accounted.add(file);
  const postTableLazy = lazyClosure(build, js, POST_TABLE_ENTRIES, accounted);
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
    {
      key: 'fonts',
      label: 'Webfonts (woff2 as served)',
      files: fonts,
      bytes: sum(fonts, (file) => statSync(join(fontsDir, file)).size),
    },
  ];
  return {
    rows,
    lazyThree: !three.some((file) => initial.includes(file)),
    eagerAccount: account.filter((file) => initial.includes(file)),
    eagerAccountUi: accountUi.filter((file) => initial.includes(file)),
    eagerSafes: [...safesDock, ...safesSheet].filter((file) => initial.includes(file)),
    eagerGacha: [...gachaDock, ...gachaSheet].filter((file) => initial.includes(file)),
    initial,
    locales,
  };
}

function kb(bytes: number): string {
  return `${(bytes / 1024).toFixed(1)} kB`;
}

function percent(share: number): string {
  return `${(share * 100).toFixed(1)} %`;
}

/**
 * A byte delta with its sign, so a shrink and a growth never read alike: in kB like the table,
 * or in bytes while it is too small to show as 0.1 kB.
 */
export function signedKb(bytes: number): string {
  if (bytes === 0) return '±0 B';
  const sign = bytes > 0 ? '+' : '-';
  const size = Math.abs(bytes);
  return `${sign}${size < NOTABLE_DELTA_BYTES ? `${String(size)} B` : kb(size)}`;
}

/**
 * ok below BUNDLE_NEAR of the budget, near from there up to the budget, over within the tolerance
 * and fail beyond it. Only fail turns the gate red.
 */
export function budgetStatus(bytes: number, budget: number): BudgetStatus {
  const used = bytes / budget;
  if (used > 1 + BUNDLE_TOLERANCE) return 'fail';
  if (used > 1) return 'over';
  return used >= BUNDLE_NEAR ? 'near' : 'ok';
}

function statusCell(status: BudgetStatus, bytes: number, budget: number): string {
  switch (status) {
    case 'ok':
      return 'ok';
    case 'near':
      return `near, ${kb(budget - bytes)} left`;
    case 'over':
      return 'over, within tolerance';
    case 'fail':
      return 'FAIL';
  }
}

/** The bytes a row grew by since the base, or undefined for a row the base build has no file in. */
function deltaOf(row: Row, base: BaseRows | undefined): number | undefined {
  const before = base?.rows.find(({ key }) => key === row.key);
  if (before === undefined || before.files.length === 0) return undefined;
  return row.bytes - before.bytes;
}

/** The budget table, its failures and, against a base build, a delta column and growth summary. */
export function budgetReport(
  rows: readonly Row[],
  budgets: Readonly<Record<BudgetKey, number>>,
  base?: BaseRows,
): BudgetReport {
  const nearPercent = `${String(Math.round(BUNDLE_NEAR * 100))} %`;
  const lines = [
    '### Bundle budgets (gzip)',
    '',
    `Fails above budget + ${String(Math.round(BUNDLE_TOLERANCE * 100))} %; **near** marks a row at ${nearPercent} of its budget or more.${
      base === undefined ? '' : ` Δ is each row's change against the base build ${base.label}.`
    }`,
    '',
    base === undefined
      ? '| Bundle | Size | Budget | Used | Status | Files |'
      : `| Bundle | Size | Δ ${base.label} | Budget | Used | Status | Files |`,
    base === undefined
      ? '| --- | ---: | ---: | ---: | --- | --- |'
      : '| --- | ---: | ---: | ---: | ---: | --- | --- |',
  ];
  const failures: string[] = [];
  const warnings: string[] = [];
  const near: string[] = [];
  const grew: { readonly label: string; readonly delta: number; readonly used: number }[] = [];
  for (const row of rows) {
    const budget = budgets[row.key];
    const used = row.bytes / budget;
    const status = budgetStatus(row.bytes, budget);
    const delta = deltaOf(row, base);
    if (status === 'fail') failures.push(`${row.label} is ${kb(row.bytes)}, budget ${kb(budget)}`);
    if (status !== 'ok') near.push(`${row.label} ${percent(used)}`);
    if (delta !== undefined && delta >= NOTABLE_DELTA_BYTES) {
      grew.push({ label: row.label, delta, used });
      if (status !== 'ok') {
        warnings.push(
          `${row.label} grew ${signedKb(delta)} against ${base?.label ?? 'the base'} to ${kb(row.bytes)}, ${percent(used)} of its ${kb(budget)} budget`,
        );
      }
    }
    const cells = [
      row.label,
      kb(row.bytes),
      ...(base === undefined ? [] : [delta === undefined ? 'new' : signedKb(delta)]),
      kb(budget),
      percent(used),
      statusCell(status, row.bytes, budget),
      row.files.join(', '),
    ];
    lines.push(`| ${cells.join(' | ')} |`);
  }
  lines.push(
    '',
    near.length === 0
      ? `Every row is under ${nearPercent} of its budget.`
      : `At ${nearPercent} of budget or more (${String(near.length)}): ${near.join(', ')}.`,
  );
  if (base !== undefined) {
    const growth = grew
      .sort((a, b) => b.delta - a.delta)
      .map(({ label, delta, used }) => `${label} ${signedKb(delta)} (now ${percent(used)})`);
    lines.push(
      growth.length === 0
        ? `No row grew by 0.1 kB or more against ${base.label}.`
        : `Grew against ${base.label}: ${growth.join(', ')}.`,
    );
  }
  return { lines, failures, warnings };
}

function baseShaFromEnv(): string | undefined {
  const raw = process.env.BASE_SHA?.trim() ?? '';
  if (raw === '' || /^0+$/.test(raw)) return undefined;
  if (!COMMIT_SHA.test(raw))
    fail(`BASE_SHA must be a commit sha (7 to 40 hex digits), got "${raw}"`);
  return raw;
}

function git(args: readonly string[]): string {
  return execFileSync('git', args, {
    cwd: APP_DIR,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'inherit'],
  }).trim();
}

/** Runs a build step with its output on stderr, so stdout carries only the report. */
function runQuietly(command: string, args: readonly string[], cwd: string, env: NodeJS.ProcessEnv) {
  execFileSync(command, args, { cwd, env, stdio: ['ignore', 2, 2] });
}

/**
 * Builds the base commit the way perf.yml builds the PR (Demo Mode, no VITE_API_URL) in a
 * temporary git worktree, measures it leniently and removes the worktree. CI checks out one
 * commit deep, so a base it lacks is fetched by sha first.
 */
function measureBase(sha: string): BaseRows {
  const known = spawnSync('git', ['cat-file', '-e', `${sha}^{commit}`], {
    cwd: APP_DIR,
    stdio: 'ignore',
  });
  if (known.status !== 0) git(['fetch', '--no-tags', '--depth=1', 'origin', sha]);
  const commit = git(['rev-parse', '--verify', `${sha}^{commit}`]);
  const dir = mkdtempSync(join(tmpdir(), 'coinposh-bundle-base-'));
  try {
    git(['worktree', 'add', '--detach', dir, commit]);
    const env = { ...process.env, VITE_API_URL: '' };
    process.stderr.write(`bundle-size: building base ${commit.slice(0, 7)} in ${dir}\n`);
    runQuietly('pnpm', ['i', '--frozen-lockfile', '--prefer-offline'], dir, env);
    runQuietly('pnpm', ['--filter', '@coinposh/web...', 'build'], dir, env);
    const web = join(dir, 'apps', 'web');
    const { rows } = measure({
      dist: join(web, 'dist'),
      locales: join(web, 'src', 'i18n', 'locales'),
      strict: false,
    });
    return { label: commit.slice(0, 7), rows };
  } finally {
    spawnSync('git', ['worktree', 'remove', '--force', dir], { cwd: APP_DIR, stdio: 'ignore' });
    rmSync(dir, { recursive: true, force: true });
  }
}

function annotate(message: string): void {
  if (process.env.GITHUB_ACTIONS === 'true') {
    process.stdout.write(`::warning title=Bundle budget headroom::${message}\n`);
  }
}

function main(): void {
  const baseSha = baseShaFromEnv();
  const {
    rows,
    lazyThree,
    eagerAccount,
    eagerAccountUi,
    eagerSafes,
    eagerGacha,
    initial,
    locales,
  } = measure(HEAD_BUILD);
  let base: BaseRows | undefined;
  let baseError: string | undefined;
  if (baseSha !== undefined) {
    try {
      base = measureBase(baseSha);
    } catch (error) {
      baseError = error instanceof Error ? error.message : String(error);
    }
  }
  const report = budgetReport(rows, BUDGETS, base);
  const lines = [...report.lines];
  const failures = [...report.failures];
  const warnings = [...report.warnings];
  if (baseError !== undefined) {
    const message = `No delta against BASE_SHA ${String(baseSha)}: ${baseError}`;
    lines.push(message);
    warnings.push(message);
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
  const misfiled = misfiledLocales(rows, reader(HEAD_BUILD), localeSources());
  lines.push(
    misfiled.length === 0
      ? `Locale chunks count once, in the i18n namespaces row (${String(locales.size)} found): no code row, Account (on tap) included, holds a whole locale file.`
      : `FAIL: ${misfiled.join('; ')}.`,
  );
  failures.push(...misfiled);

  const text = `${lines.join('\n')}\n`;
  const summary = process.env.GITHUB_STEP_SUMMARY;
  if (summary) appendFileSync(summary, text);
  process.stdout.write(text);
  for (const warning of warnings) annotate(warning);
  if (failures.length > 0) {
    process.stderr.write(`\nbundle-size: over budget:\n- ${failures.join('\n- ')}\n`);
    process.exitCode = 1;
  }
}

if (import.meta.main) main();
