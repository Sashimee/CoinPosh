import { describe, expect, it, vi } from 'vitest';
import { detectBackend, fallbackBackend, reportBackend } from './backend.ts';

function recordingLogger() {
  return { info: vi.fn<(message: string) => void>(), warn: vi.fn<(message: string) => void>() };
}

describe('detectBackend', () => {
  it('reports webgpu only when the backend flags itself as WebGPU', () => {
    expect(detectBackend({ isWebGPUBackend: true })).toBe('webgpu');
  });

  it('treats a backend without the WebGPU flag as the WebGL2 fallback', () => {
    expect(detectBackend({})).toBe('webgl2');
    expect(detectBackend({ isWebGPUBackend: false })).toBe('webgl2');
    expect(detectBackend({ isWebGLBackend: true })).toBe('webgl2');
  });
});

describe('fallbackBackend', () => {
  it('rebuilds on WebGL2 when the WebGPU backend fails to start or loses its device', () => {
    expect(fallbackBackend('webgpu')).toBe('webgl2');
  });

  it('has nothing left to fall back to once WebGL2 has failed', () => {
    expect(fallbackBackend('webgl2')).toBeNull();
  });
});

describe('reportBackend', () => {
  it('logs WebGPU as info without warning', () => {
    const logger = recordingLogger();
    reportBackend('webgpu', logger);
    expect(logger.info).toHaveBeenCalledWith(expect.stringContaining('WebGPU'));
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it('warns when the renderer fell back to WebGL2', () => {
    const logger = recordingLogger();
    reportBackend('webgl2', logger);
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('fell back to WebGL2'));
    expect(logger.info).not.toHaveBeenCalled();
  });
});
