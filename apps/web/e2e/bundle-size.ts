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
/** Characters the minifier escapes in a string, including French no-break spaces before `:`. */
const ESCAPED_IN_OUTPUT = /[`\\]|\$\{|[^\S ]|[\p{Cc}\p{Cf}]/u;

type BudgetKey = keyof typeof BUNDLE_BUDGETS | 'accountOnTap';

interface LocaleSource extends LocaleFile {
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

interface Row {
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
function localeSources(): LocaleSource[] {
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

/**
 * The lazy chunks that hold exactly one namespace locale file. A data-only chunk named after a
 * namespace that matches no file fails the gate, so a minifier change cannot silently move locale
 * bytes back into a code row.
 */
function localeChunks(lazy: readonly string[]): Map<string, LocaleChunk> {
  const sources = localeSources();
  const namespaces = [...new Set(sources.map((source) => source.namespace))];
  const chunks = new Map<string, LocaleChunk>();
  for (const file of lazy) {
    const source = read(file).trim();
    if (!DATA_MODULE.test(source)) continue;
    const matches = sources.filter(({ leaves }) => leaves.every((leaf) => source.includes(leaf)));
    if (matches.length > 1) {
      fail(
        `${file} matches ${matches.map((match) => `${match.language}/${match.namespace}.json`).join(' and ')}; update the gate`,
      );
    }
    const [match] = matches;
    if (match === undefined) {
      if (namespaces.some((namespace) => file.split('-').includes(namespace))) {
        fail(`${file} looks like a locale chunk but matches no locales/<language>/<ns>.json`);
      }
      continue;
    }
    chunks.set(file, { file, language: match.language, namespace: match.namespace });
  }
  return chunks;
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
    initial,
    locales,
  };
}

function kb(bytes: number): string {
  return `${(bytes / 1024).toFixed(1)} kB`;
}

const { rows, lazyThree, eagerAccount, eagerAccountUi, eagerSafes, initial, locales } = measure();
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
if (eagerAccount.length > 0) failures.push('account code is statically reachable from index.html');
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
const misfiled = rows.flatMap((row) =>
  row.key === 'i18nNamespaces'
    ? []
    : row.files
        .filter((file) => locales.has(file))
        .map((file) => `${file} is a locale chunk counted under ${row.label}`),
);
lines.push(
  misfiled.length === 0
    ? `Locale chunks count once, in the i18n namespaces row (${String(locales.size)} found): none under Account (on tap) or a code row.`
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
