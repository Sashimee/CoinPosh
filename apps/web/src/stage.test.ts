import { describe, expect, it } from 'vitest';
import { backendRequestedBy } from './stage.ts';

describe('backendRequestedBy', () => {
  it.each(['?webgl', '?webgl=1', '?webgl=', '?quality=low&webgl', '?webgl&quality=high'])(
    'starts on WebGL2 for %s',
    (search) => {
      expect(backendRequestedBy(search)).toBe('webgl2');
    },
  );

  it.each(['', '?', '?quality=low', '?webgpu', '?nowebgl', '?webgl2'])(
    'starts on WebGPU for "%s"',
    (search) => {
      expect(backendRequestedBy(search)).toBe('webgpu');
    },
  );
});
