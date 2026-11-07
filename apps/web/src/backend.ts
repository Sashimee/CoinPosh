export type RenderBackend = 'webgpu' | 'webgl2';

export interface BackendLogger {
  info(message: string): void;
  warn(message: string): void;
}

export function detectBackend(backend: object): RenderBackend {
  return 'isWebGPUBackend' in backend && backend.isWebGPUBackend === true ? 'webgpu' : 'webgl2';
}

export function reportBackend(kind: RenderBackend, logger: BackendLogger = console): void {
  if (kind === 'webgpu') {
    logger.info('[CoinPosh] Renderer backend: WebGPU');
  } else {
    logger.warn('[CoinPosh] WebGPU unavailable, renderer fell back to WebGL2');
  }
}
