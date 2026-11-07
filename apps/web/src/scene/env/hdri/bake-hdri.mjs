// Usage (from apps/web): node src/scene/env/hdri/bake-hdri.mjs <source.hdr> <out.hdr> [halvings]
// Regenerates a shipped HDRI from its Poly Haven original; see SOURCES.md for the inputs.
import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { bakeHdri, VENICE_SUNSET_GRADE } from './bake.ts';

const [source, target, halvings = '1'] = process.argv.slice(2);
if (!source || !target) {
  console.error('Usage: node bake-hdri.mjs <source.hdr> <out.hdr> [halvings]');
  process.exit(1);
}
const input = await readFile(source);
const buffer = input.buffer.slice(input.byteOffset, input.byteOffset + input.byteLength);
const output = bakeHdri(buffer, VENICE_SUNSET_GRADE, Number(halvings));
await writeFile(target, output);
const sha = createHash('sha256').update(output).digest('hex');
console.info(`${target}: ${output.byteLength} bytes, sha256 ${sha}`);
