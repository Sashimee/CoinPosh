import { type ChildProcess, spawn } from 'node:child_process';
import { accessSync, constants, readdirSync } from 'node:fs';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createRequire, stripTypeScriptTypes } from 'node:module';
import { homedir, tmpdir } from 'node:os';
import { delimiter, dirname, join, resolve, sep } from 'node:path';
import { env, platform } from 'node:process';
import type { Readable, Writable } from 'node:stream';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';

/**
 * Runs a module of packages/sim/src in a headless Chromium and returns what its export
 * resolves to, so a test can compare the browser's run of the sim with Node's. Chromium
 * is driven over the DevTools protocol on a pipe, and the page loads the sim's own .ts
 * modules straight from src (types stripped by Node, nothing bundled) with Rapier's
 * inlined-WASM build from node_modules, so it runs the same code the worker does.
 *
 * The browser is SIM_PARITY_BROWSER when set, else Chrome or Chromium on PATH (the CI
 * runner's), else the newest Playwright Chromium in PLAYWRIGHT_BROWSERS_PATH or
 * ~/.cache/ms-playwright.
 */
export async function runInBrowser(
  modulePath: string,
  exportName: string,
  timeoutMs = 50_000,
): Promise<{ readonly value: unknown; readonly userAgent: string }> {
  const executable = findBrowser();
  const server = await serveSim();
  const profile = await mkdtemp(join(tmpdir(), 'coinposh-sim-parity-'));
  const browser = spawn(
    executable,
    [
      '--headless=new',
      '--remote-debugging-pipe',
      `--user-data-dir=${profile}`,
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-gpu',
      '--disable-extensions',
      // A throwaway local page; the sandbox needs user namespaces CI containers lack.
      '--no-sandbox',
      'about:blank',
    ],
    { stdio: ['ignore', 'ignore', 'pipe', 'pipe', 'pipe'] },
  );
  const protocol = new DevTools(browser);
  try {
    const run = async () => {
      const { targetId } = (await protocol.send('Target.createTarget', {
        url: 'about:blank',
      })) as { targetId: string };
      const { sessionId } = (await protocol.send('Target.attachToTarget', {
        targetId,
        flatten: true,
      })) as { sessionId: string };
      await protocol.send('Page.enable', {}, sessionId);
      const loaded = protocol.once('Page.loadEventFired', sessionId);
      await protocol.send('Page.navigate', { url: `${server.origin}/` }, sessionId);
      await loaded;
      const specifier = JSON.stringify(`/src/${modulePath}`);
      const reply = (await protocol.send(
        'Runtime.evaluate',
        {
          expression: `import(${specifier}).then(async (m) => ({ value: await m[${JSON.stringify(exportName)}](), userAgent: navigator.userAgent }))`,
          awaitPromise: true,
          returnByValue: true,
        },
        sessionId,
      )) as {
        result: { value?: { value: unknown; userAgent: string } };
        exceptionDetails?: { text: string; exception?: { description?: string } };
      };
      if (reply.exceptionDetails) {
        const { text, exception } = reply.exceptionDetails;
        throw new Error(`${modulePath} threw in the browser: ${exception?.description ?? text}`);
      }
      if (!reply.result.value) {
        throw new Error(`${modulePath} returned nothing the browser could hand back`);
      }
      return reply.result.value;
    };
    return await Promise.race([
      run(),
      delay(timeoutMs, undefined, { ref: false }).then(() => {
        throw new Error(
          `the browser run of ${modulePath} took over ${timeoutMs} ms (${executable})\n${protocol.stderr()}`,
        );
      }),
    ]);
  } finally {
    await protocol.close();
    await new Promise<void>((done) => {
      server.http.close(() => {
        done();
      });
    });
    await rm(profile, { recursive: true, force: true });
  }
}

const SRC_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const RAPIER_MODULE = join(
  dirname(createRequire(import.meta.url).resolve('@dimforge/rapier3d-deterministic-compat')),
  'rapier.mjs',
);
const PAGE = `<!doctype html>
<meta charset="utf-8">
<title>sim parity</title>
<script type="importmap">${JSON.stringify({
  imports: { '@dimforge/rapier3d-deterministic-compat': '/rapier.mjs' },
})}</script>
`;

/** Serves the page, src (TypeScript as JavaScript) and Rapier on a free loopback port. */
async function serveSim(): Promise<{ readonly http: Server; readonly origin: string }> {
  const http = createServer((request, response) => {
    const path = decodeURIComponent(new URL(request.url ?? '/', 'http://localhost').pathname);
    const reply = async (): Promise<[number, string, string | Buffer]> => {
      if (path === '/') {
        return [200, 'text/html', PAGE];
      }
      if (path === '/rapier.mjs') {
        return [200, 'text/javascript', await readFile(RAPIER_MODULE)];
      }
      const file = resolve(SRC_ROOT, `.${path.slice('/src'.length)}`);
      if (!path.startsWith('/src/') || !file.startsWith(SRC_ROOT + sep)) {
        return [404, 'text/plain', `not served: ${path}`];
      }
      if (file.endsWith('.ts')) {
        return [200, 'text/javascript', stripTypeScriptTypes(await readFile(file, 'utf8'))];
      }
      if (file.endsWith('.json')) {
        return [200, 'application/json', await readFile(file)];
      }
      return [404, 'text/plain', `not served: ${path}`];
    };
    reply().then(
      ([status, type, body]) => {
        response.writeHead(status, { 'content-type': type, 'cache-control': 'no-store' });
        response.end(body);
      },
      (error: unknown) => {
        response.writeHead(500, { 'content-type': 'text/plain' });
        response.end(`failed to serve ${path}: ${String(error)}`);
      },
    );
  });
  await new Promise<void>((listening, failed) => {
    http.once('error', failed);
    http.listen(0, '127.0.0.1', () => {
      listening();
    });
  });
  const { port } = http.address() as AddressInfo;
  return { http, origin: `http://127.0.0.1:${port}` };
}

/** The DevTools protocol over --remote-debugging-pipe: NUL-terminated JSON on fds 3 and 4. */
class DevTools {
  readonly #browser: ChildProcess;
  readonly #input: Writable;
  readonly #pending = new Map<
    number,
    { resolve: (result: unknown) => void; reject: (error: Error) => void }
  >();
  readonly #waiters: { method: string; sessionId: string; resolve: () => void }[] = [];
  #nextId = 1;
  #buffer = '';
  #log = '';
  #exited: Promise<void>;

  constructor(browser: ChildProcess) {
    this.#browser = browser;
    const [, , stderr, input, output] = browser.stdio as [
      unknown,
      unknown,
      Readable,
      Writable,
      Readable,
    ];
    this.#input = input;
    stderr.setEncoding('utf8').on('data', (chunk: string) => {
      this.#log = (this.#log + chunk).slice(-4000);
    });
    output.setEncoding('utf8').on('data', (chunk: string) => {
      this.#receive(chunk);
    });
    this.#exited = new Promise((done) => {
      browser.once('exit', (code, signal) => {
        this.#failAll(`the browser exited (code ${code}, signal ${signal})\n${this.#log}`);
        done();
      });
      browser.once('error', (error) => {
        this.#failAll(`the browser failed to start: ${error.message}`);
        done();
      });
    });
  }

  stderr(): string {
    return this.#log;
  }

  send(method: string, params: object, sessionId?: string): Promise<unknown> {
    const id = this.#nextId++;
    return new Promise((resolve, reject) => {
      this.#pending.set(id, { resolve, reject });
      this.#input.write(`${JSON.stringify({ id, method, params, sessionId })}\0`);
    });
  }

  once(method: string, sessionId: string): Promise<void> {
    return new Promise((resolve) => this.#waiters.push({ method, sessionId, resolve }));
  }

  async close(): Promise<void> {
    if (this.#browser.exitCode === null && this.#browser.signalCode === null) {
      // The browser exits before it answers Browser.close, which rejects the call.
      this.send('Browser.close', {}).catch(() => undefined);
      const closed = await Promise.race([
        this.#exited.then(() => true),
        delay(3000, false, { ref: false }),
      ]);
      if (!closed) {
        this.#browser.kill('SIGKILL');
        await this.#exited;
      }
    }
  }

  #receive(chunk: string): void {
    this.#buffer += chunk;
    for (let end = this.#buffer.indexOf('\0'); end >= 0; end = this.#buffer.indexOf('\0')) {
      const message = JSON.parse(this.#buffer.slice(0, end)) as {
        id?: number;
        method?: string;
        sessionId?: string;
        result?: unknown;
        error?: { message: string };
      };
      this.#buffer = this.#buffer.slice(end + 1);
      if (message.id !== undefined) {
        const call = this.#pending.get(message.id);
        this.#pending.delete(message.id);
        if (message.error) {
          call?.reject(new Error(`DevTools: ${message.error.message}`));
        } else {
          call?.resolve(message.result);
        }
        continue;
      }
      const at = this.#waiters.findIndex(
        (w) => w.method === message.method && w.sessionId === message.sessionId,
      );
      if (at >= 0) {
        this.#waiters.splice(at, 1)[0]?.resolve();
      }
    }
  }

  #failAll(reason: string): void {
    for (const call of this.#pending.values()) {
      call.reject(new Error(reason));
    }
    this.#pending.clear();
  }
}

function executableAt(path: string): boolean {
  try {
    accessSync(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/** Newest first: the Playwright Chromium builds under `root`, headless shell preferred. */
function playwrightChromiums(root: string): string[] {
  let entries: string[];
  try {
    entries = readdirSync(root);
  } catch {
    return [];
  }
  const builds = (prefix: string) =>
    entries
      .filter((name) => name.startsWith(prefix) && /^\d+$/.test(name.slice(prefix.length)))
      .sort((a, b) => Number(b.slice(prefix.length)) - Number(a.slice(prefix.length)));
  return [
    ...builds('chromium_headless_shell-').map((name) =>
      join(root, name, 'chrome-headless-shell-linux64', 'chrome-headless-shell'),
    ),
    ...builds('chromium-').map((name) => join(root, name, 'chrome-linux64', 'chrome')),
  ];
}

function findBrowser(): string {
  const chosen = env.SIM_PARITY_BROWSER;
  if (chosen) {
    if (!executableAt(chosen)) {
      throw new Error(`SIM_PARITY_BROWSER=${chosen} is not an executable file`);
    }
    return chosen;
  }
  const onPath = (env.PATH ?? '')
    .split(delimiter)
    .filter(Boolean)
    .flatMap((dir) =>
      ['google-chrome', 'google-chrome-stable', 'chromium', 'chromium-browser'].map((name) =>
        join(dir, name),
      ),
    );
  const candidates = [
    ...onPath,
    ...(platform === 'darwin'
      ? ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome']
      : []),
    ...playwrightChromiums(
      env.PLAYWRIGHT_BROWSERS_PATH ?? join(homedir(), '.cache', 'ms-playwright'),
    ),
  ];
  const found = candidates.find(executableAt);
  if (!found) {
    throw new Error(
      'The sim parity test needs Chrome or Chromium: install google-chrome or chromium, or point SIM_PARITY_BROWSER at a Chromium executable',
    );
  }
  return found;
}
