/**
 * Bans every source of nondeterminism the sim could reach. Replays run on a
 * different engine than the client (V8 on the auditor, JavaScriptCore on iOS), so
 * the rules also ban the transcendental `Math` functions and `**`: the spec only
 * requires them to be "implementation-approximated", while `+ - * /` and
 * `Math.sqrt` are correctly rounded IEEE-754 everywhere.
 */

const clock = 'Wall-clock time breaks replay. Derive time from the tick counter.';
const random = 'Use the seeded Xoshiro128ss from src/prng.ts.';
const transcendental =
  'Engine-approximated, so results differ between V8 and JavaScriptCore. Use polynomial curves built from + - * / and Math.sqrt.';
const host = 'The sim must not depend on the host environment.';

const restrictedMath = [
  'sin',
  'cos',
  'tan',
  'asin',
  'acos',
  'atan',
  'atan2',
  'sinh',
  'cosh',
  'tanh',
  'asinh',
  'acosh',
  'atanh',
  'exp',
  'expm1',
  'log',
  'log1p',
  'log2',
  'log10',
  'pow',
  'cbrt',
  'hypot',
];

/** @type {Record<string, ['error', ...unknown[]]>} */
export const determinismRules = {
  'no-restricted-globals': [
    'error',
    { name: 'Date', message: clock },
    { name: 'performance', message: clock },
    { name: 'setTimeout', message: clock },
    { name: 'setInterval', message: clock },
    { name: 'requestAnimationFrame', message: clock },
    { name: 'crypto', message: random },
    { name: 'globalThis', message: host },
    { name: 'window', message: host },
    { name: 'self', message: host },
    { name: 'process', message: host },
  ],
  'no-restricted-properties': [
    'error',
    { object: 'Math', property: 'random', message: random },
    ...restrictedMath.map((property) => ({ object: 'Math', property, message: transcendental })),
  ],
  'no-restricted-syntax': [
    'error',
    { selector: "BinaryExpression[operator='**']", message: transcendental },
    { selector: "AssignmentExpression[operator='**=']", message: transcendental },
    {
      selector: "VariableDeclarator[init.type='Identifier'][init.name='Math'] > ObjectPattern",
      message: 'Destructuring Math hides calls from the determinism rules. Call Math.x directly.',
    },
  ],
};

/** Files the rules apply to. Benchmarks are the only sim code allowed to read a clock. */
export const determinismConfig = {
  name: 'coinposh/sim-determinism',
  files: ['**/*.{ts,js}'],
  ignores: ['**/*.bench.ts', 'eslint.config.js', 'eslint.determinism.js', 'vitest.config.ts'],
  rules: determinismRules,
};
