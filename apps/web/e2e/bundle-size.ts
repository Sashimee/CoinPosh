import { appendFileSync, existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';
import { BUNDLE_BUDGETS, BUNDLE_TOLERANCE } from './budgets.ts';
import { APP_DIR } from './env.ts';

/**
 * P-124 bundle gate over apps/web/dist: gzip sizes against BUNDLE_BUDGETS, failing when one is
 * exceeded by more than BUNDLE_TOLERANCE, and failing when the three.webgpu chunk is reachable
 * from index.html without a dynamic import. Run after `pnpm build`.
 */

const DIST = join(APP_DIR, 'dist');
const ASSETS = join(DIST, 'assets');
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
const SAFES_DOCK_CHUNK = /^safes-[\w-]+\.js$/;
const SAFES_SHEET_CHUNK = /^safesSheet-[\w-]+\.js$/;

type BudgetKey = keyof typeof BUNDLE_BUDGETS | 'accountOnTap';

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
  readonly eagerSafes: readonly string[];
  readonly initial: readonly string[];
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

function measure(): Measured {
  const js = readdirSync(ASSETS).filter((file) => file.endsWith('.js'));
  const initial = [...staticClosure(entryScripts())];
  const three = js.filter((file) => file.startsWith('three.webgpu-'));
  if (three.length === 0) fail('no three.webgpu-*.js chunk in dist/assets; update the gate');
  const workers = js.filter((file) => /\.worker-[\w-]+\.js$/.test(file));
  if (workers.length === 0) fail('no *.worker-*.js chunk in dist/assets; update the gate');
  const account = js.filter((file) => ACCOUNT_CHUNK.test(file));
  if (account.length === 0) fail('no account-*.js chunk in dist/assets; update the gate');
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

  const gz = (file: string): number => gzipBytes(read(file));
  const accounted = new Set([
    ...initial,
    ...three,
    ...workers,
    ...account,
    ...safesDock,
    ...safesSheet,
  ]);
  const otherLazy = js.filter((file) => !accounted.has(file));
  const rows: Row[] = [
    { key: 'initialJs', label: 'Initial JS', files: initial, bytes: sum(initial, gz) },
    { key: 'threeChunk', label: 'three.webgpu (lazy)', files: three, bytes: sum(three, gz) },
    { key: 'workerJs', label: 'Sim worker JS', files: workers, bytes: workerBytes },
    { key: 'wasm', label: 'Rapier wasm', files: wasmFiles, bytes: wasmBytes },
    { key: 'otherLazyJs', label: 'Other lazy JS', files: otherLazy, bytes: sum(otherLazy, gz) },
    { key: 'accountOnTap', label: 'Account (on tap)', files: account, bytes: sum(account, gz) },
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
  ];
  return {
    rows,
    lazyThree: !three.some((file) => initial.includes(file)),
    eagerAccount: account.filter((file) => initial.includes(file)),
    eagerSafes: [...safesDock, ...safesSheet].filter((file) => initial.includes(file)),
    initial,
  };
}

function kb(bytes: number): string {
  return `${(bytes / 1024).toFixed(1)} kB`;
}

const { rows, lazyThree, eagerAccount, eagerSafes, initial } = measure();
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
  eagerSafes.length === 0
    ? 'The safes chunks are lazy: the dock loads after the table, the sheet on the first press.'
    : `FAIL: safes code is in the initial load (${eagerSafes.join(', ')}).`,
);
if (eagerSafes.length > 0) failures.push('safes code is statically reachable from index.html');

const report = `${lines.join('\n')}\n`;
const summary = process.env.GITHUB_STEP_SUMMARY;
if (summary) appendFileSync(summary, report);
process.stdout.write(report);
if (failures.length > 0) {
  process.stderr.write(`\nbundle-size: over budget:\n- ${failures.join('\n- ')}\n`);
  process.exitCode = 1;
}
