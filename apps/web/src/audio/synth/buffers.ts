import type { Rng } from '../rng.ts';

export function fillWhiteNoise(data: Float32Array, rng: Rng): void {
  for (let i = 0; i < data.length; i++) data[i] = rng() * 2 - 1;
}

/**
 * Exponentially decaying noise with a one-pole lowpass whose cutoff falls over time, which is
 * how real rooms lose their highs first. Channels use independent noise so the tail is wide
 * but still sums cleanly to mono.
 */
export function fillRoomImpulse(
  data: Float32Array,
  sampleRate: number,
  t60: number,
  rng: Rng,
  predelaySeconds = 0.008,
): void {
  const decay = Math.log(1000) / (t60 * sampleRate);
  const predelay = Math.floor(predelaySeconds * sampleRate);
  let lowpassed = 0;
  for (let i = 0; i < data.length; i++) {
    if (i < predelay) {
      data[i] = 0;
      continue;
    }
    const n = i - predelay;
    const progress = n / Math.max(1, data.length - predelay);
    const smoothing = 0.15 + 0.75 * progress;
    lowpassed = lowpassed * smoothing + (rng() * 2 - 1) * (1 - smoothing);
    data[i] = lowpassed * Math.exp(-decay * n);
  }
}

export function createNoiseBuffer(ctx: BaseAudioContext, seconds: number, rng: Rng): AudioBuffer {
  const buffer = ctx.createBuffer(1, Math.ceil(seconds * ctx.sampleRate), ctx.sampleRate);
  fillWhiteNoise(buffer.getChannelData(0), rng);
  return buffer;
}

export function createRoomImpulse(
  ctx: BaseAudioContext,
  t60: number,
  channels: number,
  rng: Rng,
): AudioBuffer {
  const buffer = ctx.createBuffer(channels, Math.ceil(t60 * ctx.sampleRate), ctx.sampleRate);
  for (let c = 0; c < channels; c++) {
    fillRoomImpulse(buffer.getChannelData(c), ctx.sampleRate, t60, rng);
  }
  return buffer;
}
