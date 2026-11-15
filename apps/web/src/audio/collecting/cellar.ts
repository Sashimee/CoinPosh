import type { PumpTimer } from '../music/adaptive/player.ts';
import { midiToHz } from '../music/theory.ts';
import { lerp, type Rng } from '../rng.ts';
import { createRoomImpulse } from '../synth/buffers.ts';
import { scheduleDecayingSine, SourceVoice } from '../synth/voice.ts';
import { VoicePriority, type VoicePool } from '../voicePool.ts';

/** Long enough that the ear stops hunting for the seam. */
export const CELLAR_LOOP_SECONDS = 10;
/**
 * The bed is rumble, a low drone and faint air, all under 8 kHz, so it renders at 16 kHz and the
 * context resamples it: a third of the memory (1.3 MB) and of the one-off render time.
 */
export const CELLAR_BED_SAMPLE_RATE = 16000;
const CROSSFADE_SECONDS = 0.75;
const BED_PEAK = 0.6;
const RUMBLE_CUTOFF_HZ = 240;
const AIR_LEVEL = 0.025;
const NOISE_SHARE = 0.62;
const DRONE_LEVEL = 0.4 * (1 - NOISE_SHARE);
/** D2, A2, D3, A3: the stone vault hums on the Riviera key's tonic and fifth. */
const DRONE = [
  { midi: 38, level: 1, breaths: 2 },
  { midi: 45, level: 0.5, breaths: 3 },
  { midi: 50, level: 0.32, breaths: 1 },
  { midi: 57, level: 0.14, breaths: 4 },
] as const;
const STEREO_PHASE = 0.35;

/**
 * Snaps a frequency to a whole number of cycles over the loop so the sine ends exactly where it
 * began and the loop point is sample-continuous.
 */
export function loopSafeFrequency(
  frequency: number,
  loopSamples: number,
  sampleRate: number,
): number {
  const cycles = Math.max(1, Math.round((frequency * loopSamples) / sampleRate));
  return (cycles * sampleRate) / loopSamples;
}

function fillRumble(data: Float32Array, sampleRate: number, rng: Rng): void {
  const lowpass = Math.exp((-2 * Math.PI * RUMBLE_CUTOFF_HZ) / sampleRate);
  let brown = 0;
  let low = 0;
  let airLow = 0;
  for (let i = 0; i < data.length; i++) {
    const white = rng() * 2 - 1;
    brown = brown * 0.996 + white * 0.04;
    low = low * lowpass + brown * (1 - lowpass);
    airLow = airLow * 0.6 + white * 0.4;
    data[i] = low * 4 + (white - airLow) * AIR_LEVEL;
  }
}

interface BreathingSine {
  /** Cycles per sample. */
  readonly frequency: number;
  readonly phase: number;
  readonly level: number;
  /** Whole swells of the 0.5..1 amplitude envelope per buffer, so it loops too. */
  readonly breaths: number;
  readonly breathPhase: number;
}

/**
 * Adds a slowly swelling sine using rotation recurrences instead of two Math.sin calls per
 * sample: ten seconds of stereo drone renders in a few milliseconds instead of a dropped frame.
 */
function addBreathingSine(data: Float32Array, sine: BreathingSine): void {
  const step = 2 * Math.PI * sine.frequency;
  const breathStep = (2 * Math.PI * sine.breaths) / data.length;
  const [dc, ds] = [Math.cos(step), Math.sin(step)];
  const [bdc, bds] = [Math.cos(breathStep), Math.sin(breathStep)];
  let [c, s] = [Math.cos(sine.phase), Math.sin(sine.phase)];
  let [bc, bs] = [Math.cos(sine.breathPhase), Math.sin(sine.breathPhase)];
  for (let i = 0; i < data.length; i++) {
    data[i] = (data[i] ?? 0) + sine.level * (0.75 + 0.25 * bs) * s;
    const nextC = c * dc - s * ds;
    s = s * dc + c * ds;
    c = nextC;
    const nextBc = bc * bdc - bs * bds;
    bs = bs * bdc + bc * bds;
    bc = nextBc;
  }
}

/**
 * Renders the cellar's room tone into `channels`, each exactly one loop long: a brown-noise
 * rumble with dry air on top, and a breathing drone on the venue's tonic. The noise is rendered
 * past the loop and its tail equal-power crossfaded into the head, and every periodic part has
 * a whole number of cycles per loop, so the buffer repeats without a click or a level dip.
 */
export function fillCellarBed(
  channels: readonly Float32Array[],
  sampleRate: number,
  rng: Rng,
): void {
  const first = channels[0];
  if (!first || first.length < 4) {
    throw new RangeError('The cellar bed needs at least one channel of four or more samples.');
  }
  const loop = first.length;
  if (channels.some((data) => data.length !== loop)) {
    throw new RangeError('Every cellar bed channel must be the same length.');
  }
  const fade = Math.min(Math.floor(CROSSFADE_SECONDS * sampleRate), Math.floor(loop / 4));
  const scratch = new Float32Array(loop + fade);

  channels.forEach((data, channel) => {
    fillRumble(scratch, sampleRate, rng);
    for (let i = 0; i < fade; i++) {
      const t = (i + 0.5) / fade;
      const blended =
        (scratch[i] ?? 0) * Math.sin((t * Math.PI) / 2) +
        (scratch[loop + i] ?? 0) * Math.cos((t * Math.PI) / 2);
      data[i] = blended * NOISE_SHARE;
    }
    for (let i = fade; i < loop; i++) data[i] = (scratch[i] ?? 0) * NOISE_SHARE;

    DRONE.forEach(({ midi, level, breaths }, k) => {
      addBreathingSine(data, {
        frequency: loopSafeFrequency(midiToHz(midi), loop, sampleRate) / sampleRate,
        phase: channel * STEREO_PHASE + k * 1.3,
        level: level * DRONE_LEVEL,
        breaths,
        breathPhase: k,
      });
    });
  });

  let peak = 0;
  for (const data of channels) for (const v of data) peak = Math.max(peak, Math.abs(v));
  if (peak === 0) throw new Error('The cellar bed rendered silent; check the injected rng.');
  const scale = BED_PEAK / peak;
  for (const data of channels) for (let i = 0; i < loop; i++) data[i] = (data[i] ?? 0) * scale;
}

export interface DripSpec {
  readonly kind: 'drip';
  readonly frequency: number;
  readonly endFrequency: number;
  readonly sweep: number;
  readonly t60: number;
  readonly gain: number;
  readonly pan: number;
}

export interface ClinkSpec {
  readonly kind: 'clink';
  readonly partials: readonly { frequency: number; amplitude: number; t60: number }[];
  readonly gain: number;
  readonly pan: number;
}

export type CellarEvent = DripSpec | ClinkSpec;

export const CELLAR_EVENT_GAP: readonly [number, number] = [1.6, 5.5];
const CLINK_SHARE = 0.18;
const CLINK_RATIOS = [1, 2.32, 4.25];

/**
 * A water drip rises in pitch as the bubble it leaves resonates; a bottle settling in the rack
 * is a faint glass ting. Both are rare and soft enough to sit under conversation.
 */
export function buildCellarEvent(rng: Rng): CellarEvent {
  const pan = (rng() * 2 - 1) * 0.7;
  if (rng() < CLINK_SHARE) {
    const base = lerp(2300, 2900, rng());
    return {
      kind: 'clink',
      pan,
      gain: lerp(0.035, 0.06, rng()),
      partials: CLINK_RATIOS.map((ratio, k) => ({
        frequency: base * ratio,
        amplitude: 0.7 ** k,
        t60: 0.7 / (k + 1),
      })),
    };
  }
  const frequency = lerp(720, 1350, rng());
  return {
    kind: 'drip',
    pan,
    frequency,
    endFrequency: frequency * lerp(1.8, 2.5, rng()),
    sweep: lerp(0.022, 0.045, rng()),
    t60: lerp(0.07, 0.12, rng()),
    gain: lerp(0.07, 0.15, rng()),
  };
}

export function cellarEventCost(event: CellarEvent): number {
  return event.kind === 'drip' ? 1 : event.partials.length;
}

function startCellarEventVoice(
  ctx: BaseAudioContext,
  event: CellarEvent,
  destination: AudioNode,
  when: number,
): SourceVoice {
  const voice = new SourceVoice(
    ctx,
    VoicePriority.quietImpact,
    when,
    event.gain,
    event.pan,
    destination,
  );
  if (event.kind === 'clink') {
    for (const p of event.partials)
      scheduleDecayingSine(voice, p.frequency, p.amplitude, p.t60, when);
    return voice;
  }
  const oscillator = new OscillatorNode(ctx, { frequency: event.frequency });
  oscillator.frequency.setValueAtTime(event.frequency, when);
  oscillator.frequency.exponentialRampToValueAtTime(event.endFrequency, when + event.sweep);
  const envelope = new GainNode(ctx, { gain: 0 });
  envelope.gain.setValueAtTime(0, when);
  envelope.gain.linearRampToValueAtTime(1, when + 0.0015);
  envelope.gain.exponentialRampToValueAtTime(0.001, when + 0.0015 + event.t60);
  oscillator.connect(envelope).connect(voice.output);
  oscillator.start(when);
  voice.track(oscillator, when + 0.0015 + event.t60 + 0.005);
  return voice;
}

export const AMBIENCE_LEVEL = 0.45;
export const AMBIENCE_FADE_IN_SECONDS = 3;
export const AMBIENCE_FADE_OUT_SECONDS = 1.5;
const VAULT_T60 = 2.6;
const VAULT_SEND = 0.55;
const EVENT_LOOKAHEAD = 0.3;
export const CELLAR_PUMP_MS = 100;

export interface CellarAmbienceOptions {
  /** The music bus: the bed follows the music slider and ducks under stingers. */
  readonly output: AudioNode;
  readonly rng: Rng;
  readonly timer: PumpTimer;
  /** The collecting voice pool; drips borrow its lowest priority and never steal a prize. */
  readonly pool: VoicePool<SourceVoice>;
}

interface Session {
  readonly fader: GainNode;
  readonly source: AudioBufferSourceNode;
  readonly events: GainNode;
  readonly vault: ConvolverNode;
  readonly cancelPump: () => void;
}

export class CellarAmbience {
  private bed: AudioBuffer | null = null;
  private vaultImpulse: AudioBuffer | null = null;
  private session: Session | null = null;
  private nextEventAt = 0;
  private disposed = false;

  constructor(
    private readonly ctx: BaseAudioContext,
    private readonly options: CellarAmbienceOptions,
  ) {}

  get isPlaying(): boolean {
    return this.session !== null;
  }

  start(): void {
    if (this.disposed) throw new Error('The cellar ambience was disposed; create a new one.');
    if (this.session) return;
    const { ctx, options } = this;
    const now = ctx.currentTime;
    const bed = this.bedBuffer();
    const fader = new GainNode(ctx, { gain: 0 });
    fader.gain.setValueAtTime(0, now);
    fader.gain.linearRampToValueAtTime(AMBIENCE_LEVEL, now + AMBIENCE_FADE_IN_SECONDS);
    fader.connect(options.output);

    const source = new AudioBufferSourceNode(ctx, { buffer: bed, loop: true });
    source.connect(fader);
    source.start(now, options.rng() * bed.duration);

    const events = new GainNode(ctx, { gain: 1 });
    const vault = new ConvolverNode(ctx, { buffer: this.impulse() });
    events.connect(fader);
    events
      .connect(new GainNode(ctx, { gain: VAULT_SEND }))
      .connect(vault)
      .connect(fader);

    this.nextEventAt = now + this.gap();
    const cancelPump = options.timer(CELLAR_PUMP_MS, () => {
      this.pump();
    });
    this.session = { fader, source, events, vault, cancelPump };
  }

  stop(fadeSeconds = AMBIENCE_FADE_OUT_SECONDS): void {
    if (!Number.isFinite(fadeSeconds) || fadeSeconds < 0) {
      throw new RangeError(
        `Cellar fade must be a finite number of seconds >= 0, got ${fadeSeconds}`,
      );
    }
    const session = this.session;
    if (!session) return;
    this.session = null;
    session.cancelPump();
    const now = this.ctx.currentTime;
    const gain = session.fader.gain;
    gain.cancelScheduledValues(now);
    gain.setValueAtTime(gain.value, now);
    gain.linearRampToValueAtTime(0, now + fadeSeconds);
    session.source.onended = () => {
      session.fader.disconnect();
      session.events.disconnect();
      session.vault.disconnect();
    };
    session.source.stop(now + fadeSeconds + 0.02);
  }

  dispose(): void {
    if (this.disposed) return;
    this.stop(0.05);
    this.disposed = true;
    this.bed = null;
    this.vaultImpulse = null;
  }

  private gap(): number {
    const [min, max] = CELLAR_EVENT_GAP;
    return lerp(min, max, this.options.rng());
  }

  private pump(): void {
    const session = this.session;
    if (!session) return;
    const now = this.ctx.currentTime;
    if (this.ctx.state !== 'running') {
      this.nextEventAt = Math.max(this.nextEventAt, now + this.gap());
      return;
    }
    while (this.nextEventAt < now + EVENT_LOOKAHEAD) {
      const when = Math.max(this.nextEventAt, now);
      const event = buildCellarEvent(this.options.rng);
      const { pool } = this.options;
      if (pool.canAdmit(VoicePriority.quietImpact, cellarEventCost(event), now)) {
        pool.admit(startCellarEventVoice(this.ctx, event, session.events, when), now);
      }
      this.nextEventAt = when + this.gap();
    }
  }

  private bedBuffer(): AudioBuffer {
    if (this.bed) return this.bed;
    const sampleRate = CELLAR_BED_SAMPLE_RATE;
    const buffer = this.ctx.createBuffer(
      2,
      Math.round(CELLAR_LOOP_SECONDS * sampleRate),
      sampleRate,
    );
    fillCellarBed(
      [buffer.getChannelData(0), buffer.getChannelData(1)],
      sampleRate,
      this.options.rng,
    );
    this.bed = buffer;
    return buffer;
  }

  private impulse(): AudioBuffer {
    this.vaultImpulse ??= createRoomImpulse(this.ctx, VAULT_T60, 2, this.options.rng);
    return this.vaultImpulse;
  }
}
