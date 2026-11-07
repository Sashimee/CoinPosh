import {
  DataTexture,
  LinearFilter,
  LinearMipmapLinearFilter,
  NoColorSpace,
  NodeMaterial,
  QuadMesh,
  RenderTarget,
  RepeatWrapping,
  RGBAFormat,
  UnsignedByteType,
  type ColorSpace,
  type Node,
  type WebGPURenderer,
  type Wrapping,
} from 'three/webgpu';
import { screenUV } from 'three/tsl';

export interface BakeOptions {
  readonly name: string;
  readonly width: number;
  readonly height: number;
  /** Colour space the baked RGB is encoded in; alpha is always stored linear. */
  readonly colorSpace: ColorSpace;
  readonly wrapS?: Wrapping;
  readonly wrapT?: Wrapping;
  readonly anisotropy?: number;
}

/**
 * Renders a TSL pattern once into an RGBA8 texture and reads it back to the CPU, so costly
 * procedural noise is paid for at load instead of every frame. `pattern` receives UVs in
 * [0, 1]² and its texel at (u, v) is what the returned texture samples at (u, v). The result is
 * a DataTexture so a renderer rebuilt after a device loss re-uploads it from the CPU copy.
 */
export async function bakeTexture(
  renderer: WebGPURenderer,
  pattern: (uv: Node<'vec2'>) => Node<'vec4'>,
  options: BakeOptions,
): Promise<DataTexture> {
  const { width, height } = options;
  if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1) {
    throw new RangeError(
      `Bake ${options.name} needs a positive integer size, got ${width}x${height}`,
    );
  }
  await renderer.init();

  const target = new RenderTarget(width, height, {
    type: UnsignedByteType,
    format: RGBAFormat,
    colorSpace: NoColorSpace,
    depthBuffer: false,
    generateMipmaps: false,
  });
  const material = new NodeMaterial();
  material.name = `bake/${options.name}`;
  material.fragmentNode = pattern(screenUV);
  material.depthTest = false;
  material.depthWrite = false;
  const quad = new QuadMesh(material);

  let pixels: Uint8Array;
  try {
    // Bakes run concurrently; restoring before the await keeps one bake from restoring
    // another's (soon disposed) target as the renderer's output.
    const previous = renderer.getRenderTarget();
    renderer.setRenderTarget(target);
    try {
      quad.render(renderer);
    } finally {
      renderer.setRenderTarget(previous);
    }
    const read = await renderer.readRenderTargetPixelsAsync(target, 0, 0, width, height);
    if (!(read instanceof Uint8Array) || read.length < width * height * 4) {
      throw new Error(`Bake ${options.name} read back ${read.length} values, expected RGBA8`);
    }
    pixels = new Uint8Array(read.buffer, read.byteOffset, width * height * 4).slice();
  } finally {
    quad.geometry.dispose();
    material.dispose();
    target.dispose();
  }

  // WebGL reads framebuffers bottom row first, while screenUV runs top-down on both backends.
  if ('isWebGLBackend' in renderer.backend && renderer.backend.isWebGLBackend) {
    flipRowsInPlace(pixels, width * 4, height);
  }

  const texture = new DataTexture(pixels, width, height, RGBAFormat, UnsignedByteType);
  texture.name = options.name;
  texture.colorSpace = options.colorSpace;
  texture.wrapS = options.wrapS ?? RepeatWrapping;
  texture.wrapT = options.wrapT ?? RepeatWrapping;
  texture.magFilter = LinearFilter;
  texture.minFilter = LinearMipmapLinearFilter;
  texture.generateMipmaps = true;
  texture.anisotropy = options.anisotropy ?? 1;
  texture.needsUpdate = true;
  return texture;
}

function flipRowsInPlace(pixels: Uint8Array, stride: number, height: number): void {
  const row = new Uint8Array(stride);
  for (let top = 0, bottom = height - 1; top < bottom; top += 1, bottom -= 1) {
    row.set(pixels.subarray(top * stride, (top + 1) * stride));
    pixels.copyWithin(top * stride, bottom * stride, (bottom + 1) * stride);
    pixels.set(row, bottom * stride);
  }
}
