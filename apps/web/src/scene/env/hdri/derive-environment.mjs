// Derives the shipped venue environment from the Poly Haven source HDRI, as recorded in
// SOURCES.md. Run from apps/web:
//   node src/scene/env/hdri/derive-environment.mjs <venice_sunset_1k.hdr> <out.ktx2>
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { constants, zstdCompressSync } from 'node:zlib';
import { DataUtils, FloatType } from 'three';
import { HDRLoader } from 'three/addons/loaders/HDRLoader.js';
import {
  createDefaultContainer,
  KHR_DF_CHANNEL_RGBSDA_ALPHA,
  KHR_DF_CHANNEL_RGBSDA_BLUE,
  KHR_DF_CHANNEL_RGBSDA_GREEN,
  KHR_DF_CHANNEL_RGBSDA_RED,
  KHR_DF_MODEL_RGBSDA,
  KHR_DF_PRIMARIES_BT709,
  KHR_DF_SAMPLE_DATATYPE_FLOAT,
  KHR_DF_SAMPLE_DATATYPE_SIGNED,
  KHR_DF_TRANSFER_LINEAR,
  KHR_SUPERCOMPRESSION_ZSTD,
  VK_FORMAT_R16G16B16A16_SFLOAT,
  write,
} from 'three/addons/libs/ktx-parse.module.js';
import { downsampleRgba, flipRows, gradeRadiance } from '../radiance.ts';

const SOURCE_SHA256 = '92fe2b29b1957828fb8925a57633540bbba5bf380d9285ed553443e834249352';
const GRADE = { maxRadiance: 6, tint: [1.15, 0.86, 0.72] };
const DOWNSAMPLE = 2;
// Half floats carry 10 mantissa bits; IBL only needs RGBE-like precision once PMREM-blurred,
// and dropping the low bits cuts the zstd output by about a third.
const DROPPED_MANTISSA_BITS = 3;
const FLOAT_ONE_BITS = 0x3f800000;
const FLOAT_MINUS_ONE_BITS = -0x40800000;

function quantizeHalf(bits) {
  const step = 1 << DROPPED_MANTISSA_BITS;
  return Math.min((bits + step / 2) & ~(step - 1), 0x7bff);
}

const [input, output] = process.argv.slice(2);
if (!input || !output) {
  console.error('usage: derive-environment.mjs <venice_sunset_1k.hdr> <out.ktx2>');
  process.exit(2);
}

const source = readFileSync(input);
const digest = createHash('sha256').update(source).digest('hex');
if (digest !== SOURCE_SHA256) {
  throw new Error(`${input} has SHA-256 ${digest}; expected the recorded ${SOURCE_SHA256}`);
}

const loader = new HDRLoader().setDataType(FloatType);
const decoded = loader.parse(
  source.buffer.slice(source.byteOffset, source.byteOffset + source.length),
);
const full = { data: decoded.data, width: decoded.width, height: decoded.height };
const clipped = gradeRadiance(full.data, GRADE);
const image = flipRows(downsampleRgba(full, DOWNSAMPLE));

const halves = new Uint16Array(image.data.length);
let peak = 0;
for (let i = 0; i < image.data.length; i += 4) {
  for (let c = 0; c < 3; c += 1) {
    const value = image.data[i + c];
    peak = Math.max(peak, value);
    halves[i + c] = quantizeHalf(DataUtils.toHalfFloat(value));
  }
  halves[i + 3] = DataUtils.toHalfFloat(1);
}
const raw = new Uint8Array(halves.buffer);
const compressed = zstdCompressSync(raw, {
  params: { [constants.ZSTD_c_compressionLevel]: 19 },
});

const container = createDefaultContainer();
container.vkFormat = VK_FORMAT_R16G16B16A16_SFLOAT;
container.typeSize = 2;
container.pixelWidth = image.width;
container.pixelHeight = image.height;
container.pixelDepth = 0;
container.layerCount = 0;
container.faceCount = 1;
container.levelCount = 1;
container.supercompressionScheme = KHR_SUPERCOMPRESSION_ZSTD;
container.levels = [
  { levelData: new Uint8Array(compressed), uncompressedByteLength: raw.byteLength },
];
const dfd = container.dataFormatDescriptor[0];
dfd.colorModel = KHR_DF_MODEL_RGBSDA;
dfd.colorPrimaries = KHR_DF_PRIMARIES_BT709;
dfd.transferFunction = KHR_DF_TRANSFER_LINEAR;
dfd.flags = 0;
dfd.texelBlockDimension = [0, 0, 0, 0];
// libktx zeroes bytesPlane0 on supercompressed files; it is rebuilt from typeSize on inflate.
dfd.bytesPlane = [0, 0, 0, 0, 0, 0, 0, 0];
dfd.samples = [
  KHR_DF_CHANNEL_RGBSDA_RED,
  KHR_DF_CHANNEL_RGBSDA_GREEN,
  KHR_DF_CHANNEL_RGBSDA_BLUE,
  KHR_DF_CHANNEL_RGBSDA_ALPHA,
].map((channel, index) => ({
  bitOffset: index * 16,
  bitLength: 15,
  channelType: channel | KHR_DF_SAMPLE_DATATYPE_FLOAT | KHR_DF_SAMPLE_DATATYPE_SIGNED,
  samplePosition: [0, 0, 0, 0],
  sampleLower: FLOAT_MINUS_ONE_BITS,
  sampleUpper: FLOAT_ONE_BITS,
}));
container.keyValue = { KTXorientation: 'ru' };

const file = write(container);
writeFileSync(output, file);
const outDigest = createHash('sha256').update(file).digest('hex');
console.info(
  `${output}: ${image.width}x${image.height} RGBA16F zstd, ${file.byteLength} bytes, ` +
    `peak ${peak.toFixed(3)}, ${clipped} source texels clipped, SHA-256 ${outDigest}`,
);
