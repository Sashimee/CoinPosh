import { readFileSync } from 'node:fs';
import { dirname, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import packageJson from '../package.json' with { type: 'json' };
import * as sim from './index.ts';
import * as layout from './layout.ts';

const srcDir = dirname(fileURLToPath(import.meta.url));
const packageDir = resolve(srcDir, '..');

const STATIC_SPECIFIER =
  /(?:^|[;\s])(import|export)\s+(type\s+)?(?:[\w*\s{},$]*?\s+from\s+)?['"]([^'"]+)['"]/g;
const DYNAMIC_IMPORT = /\bimport\s*\(/;

function stripComments(code: string): string {
  return code.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
}

/** Specifiers `file` loads at runtime: every import or re-export that is not `type`-only. */
function runtimeSpecifiers(file: string): string[] {
  const code = stripComments(readFileSync(file, 'utf8'));
  expect(DYNAMIC_IMPORT.test(code), `${file} must not import() dynamically`).toBe(false);
  return [...code.matchAll(STATIC_SPECIFIER)].flatMap(([, , typeOnly, specifier]) =>
    typeOnly === undefined && specifier !== undefined ? [specifier] : [],
  );
}

/** Every module reached at runtime from `entry`, as paths relative to the package, plus bare specifiers. */
function runtimeGraph(entry: string): { modules: string[]; packages: string[] } {
  const seen = new Set<string>();
  const packages = new Set<string>();
  const pending = [entry];
  for (let file = pending.pop(); file !== undefined; file = pending.pop()) {
    if (seen.has(file)) continue;
    seen.add(file);
    for (const specifier of runtimeSpecifiers(file)) {
      if (specifier.startsWith('.')) {
        pending.push(resolve(dirname(file), specifier));
      } else {
        packages.add(specifier);
      }
    }
  }
  const modules = [...seen].map((file) => relative(packageDir, file)).sort();
  return { modules, packages: [...packages].sort() };
}

describe('@coinposh/sim/layout', () => {
  it('is published as a subpath export', () => {
    expect(packageJson.exports['./layout']).toBe('./src/layout.ts');
  });

  it('never loads Rapier or the simulation, so the render thread can import it', () => {
    const graph = runtimeGraph(resolve(srcDir, 'layout.ts'));
    expect(graph.packages).toEqual([]);
    expect(graph.modules).toEqual([
      'src/coin.ts',
      'src/constants.ts',
      'src/inputs.ts',
      'src/layout.ts',
      'src/table/layout.ts',
    ]);
  });

  it('exports the same values as the main entry', () => {
    const names = Object.keys(layout).sort();
    expect(names).toEqual([
      'BACKBOARD',
      'COIN',
      'COIN_DROP_HEIGHT',
      'DROP_ZONE',
      'GUTTER_START_Z',
      'MAX_DROP_OFFSET_MM',
      'NUDGE_DIRECTIONS',
      'PLAYFIELD',
      'PUSHER',
      'TABLE_INNER_HALF_WIDTH',
      'TICK_RATE_HZ',
    ]);
    for (const name of names) {
      expect(sim[name as keyof typeof sim], name).toBe(layout[name as keyof typeof layout]);
    }
  });

  it('import graph walker sees through comments and type-only imports but not value imports', () => {
    const graph = runtimeGraph(resolve(srcDir, 'sim.ts'));
    expect(graph.modules).toContain('src/rapier.ts');
    expect(graph.packages).toContain('@dimforge/rapier3d-deterministic-compat');
    expect(runtimeGraph(resolve(srcDir, 'table/heap.ts')).packages).toEqual([]);
  });
});
