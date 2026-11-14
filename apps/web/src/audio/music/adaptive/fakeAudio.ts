/**
 * A minimal Web Audio stand-in for the node test environment: it records every automation
 * call and source start against the fake clock and can evaluate a param's value at any time.
 */

type ParamEvent =
  | { readonly type: 'set'; readonly time: number; readonly value: number }
  | { readonly type: 'linear'; readonly time: number; readonly value: number }
  | {
      readonly type: 'target';
      readonly time: number;
      readonly value: number;
      readonly tau: number;
    };

export interface ScheduledCall {
  readonly what: string;
  readonly time: number;
  readonly calledAt: number;
}

export class FakeAudioContext {
  currentTime = 0;
  readonly sampleRate = 8000;
  readonly state = 'running';
  readonly calls: ScheduledCall[] = [];
  readonly nodes: FakeNode[] = [];

  createBuffer(channels: number, length: number, sampleRate: number): FakeBuffer {
    return new FakeBuffer(channels, length, sampleRate);
  }

  record(what: string, time: number): void {
    this.calls.push({ what, time, calledAt: this.currentTime });
  }
}

export class FakeBuffer {
  private readonly data: Float32Array[];
  constructor(
    readonly numberOfChannels: number,
    readonly length: number,
    readonly sampleRate: number,
  ) {
    this.data = Array.from({ length: numberOfChannels }, () => new Float32Array(length));
  }

  get duration(): number {
    return this.length / this.sampleRate;
  }

  getChannelData(channel: number): Float32Array {
    const data = this.data[channel];
    if (!data) throw new RangeError(`Fake buffer has no channel ${channel}`);
    return data;
  }
}

export class FakeParam {
  private events: ParamEvent[] = [];
  private initial: number;

  constructor(
    private readonly ctx: FakeAudioContext,
    readonly name: string,
    value: number,
  ) {
    this.initial = value;
  }

  get value(): number {
    return this.valueAt(this.ctx.currentTime);
  }

  set value(value: number) {
    this.initial = value;
  }

  get scheduled(): readonly ParamEvent[] {
    return this.events;
  }

  setValueAtTime(value: number, time: number): this {
    return this.add({ type: 'set', time, value });
  }

  linearRampToValueAtTime(value: number, time: number): this {
    return this.add({ type: 'linear', time, value });
  }

  exponentialRampToValueAtTime(value: number, time: number): this {
    return this.add({ type: 'linear', time, value });
  }

  setTargetAtTime(value: number, time: number, tau: number): this {
    return this.add({ type: 'target', time, value, tau });
  }

  cancelScheduledValues(time: number): this {
    this.ctx.record(`${this.name}.cancel`, time);
    this.events = this.events.filter((event) => event.time < time);
    return this;
  }

  valueAt(time: number): number {
    let value = this.initial;
    let previousTime = 0;
    for (let i = 0; i < this.events.length; i++) {
      const event = this.events[i];
      if (!event) break;
      if (event.time > time) {
        if (event.type !== 'linear') return value;
        const span = event.time - previousTime;
        return span <= 0
          ? event.value
          : value + ((event.value - value) * (time - previousTime)) / span;
      }
      if (event.type === 'target') {
        const until = Math.min(time, this.events[i + 1]?.time ?? Infinity);
        value = event.value + (value - event.value) * Math.exp(-(until - event.time) / event.tau);
        previousTime = until;
        if (until === time) return value;
        continue;
      }
      value = event.value;
      previousTime = event.time;
    }
    return value;
  }

  private add(event: ParamEvent): this {
    this.ctx.record(`${this.name}.${event.type}`, event.time);
    const index = this.events.findIndex((e) => e.time > event.time);
    if (index === -1) this.events.push(event);
    else this.events.splice(index, 0, event);
    return this;
  }
}

export class FakeNode {
  readonly outputs: (FakeNode | FakeParam)[] = [];
  readonly params: Record<string, FakeParam> = {};
  channelCount = 2;
  buffer: FakeBuffer | null = null;
  onended: (() => void) | null = null;

  constructor(
    readonly ctx: FakeAudioContext,
    readonly kind: string,
    options: Record<string, unknown>,
    paramDefaults: Record<string, number>,
  ) {
    for (const [name, fallback] of Object.entries(paramDefaults)) {
      const given = options[name];
      this.params[name] = new FakeParam(
        ctx,
        `${kind}.${name}`,
        typeof given === 'number' ? given : fallback,
      );
    }
    if (options.buffer instanceof FakeBuffer) this.buffer = options.buffer;
    ctx.nodes.push(this);
  }

  param(name: string): FakeParam {
    const param = this.params[name];
    if (!param) throw new Error(`Fake ${this.kind} has no "${name}" param`);
    return param;
  }

  get gain(): FakeParam {
    return this.param('gain');
  }

  get frequency(): FakeParam {
    return this.param('frequency');
  }

  connect<T extends FakeNode | FakeParam>(target: T): T {
    this.outputs.push(target);
    return target;
  }

  disconnect(): void {
    this.outputs.length = 0;
  }

  start(when = 0): void {
    this.ctx.record(`${this.kind}.start`, when);
  }

  stop(when = 0): void {
    this.ctx.record(`${this.kind}.stop`, when);
  }
}

function nodeClass(kind: string, paramDefaults: Record<string, number>) {
  return class extends FakeNode {
    constructor(ctx: FakeAudioContext, options: Record<string, unknown> = {}) {
      super(ctx, kind, options, paramDefaults);
    }
  };
}

export const FAKE_AUDIO_GLOBALS = {
  GainNode: nodeClass('GainNode', { gain: 1 }),
  OscillatorNode: nodeClass('OscillatorNode', { frequency: 440, detune: 0 }),
  BiquadFilterNode: nodeClass('BiquadFilterNode', { frequency: 350, Q: 1, gain: 0, detune: 0 }),
  StereoPannerNode: nodeClass('StereoPannerNode', { pan: 0 }),
  ConvolverNode: nodeClass('ConvolverNode', {}),
  AudioBufferSourceNode: nodeClass('AudioBufferSourceNode', { playbackRate: 1, detune: 0 }),
  DynamicsCompressorNode: nodeClass('DynamicsCompressorNode', {
    threshold: -24,
    knee: 30,
    ratio: 12,
    attack: 0.003,
    release: 0.25,
  }),
};
