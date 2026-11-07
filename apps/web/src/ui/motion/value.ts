import { schedule } from './loop.ts';
import { isReducedMotion } from './reduced.ts';
import { Spring, type SpringConfig } from './spring.ts';

/** A spring bound to a render callback; under reduced motion it jumps straight to its target. */
export class SpringValue {
  private readonly spring: Spring;
  private cancel: (() => void) | null = null;
  private resolvers: (() => void)[] = [];

  constructor(
    initial: number,
    config: SpringConfig,
    private readonly render: (value: number, velocity: number) => void,
  ) {
    this.spring = new Spring(initial, config);
    render(initial, 0);
  }

  get value(): number {
    return this.spring.value;
  }

  get target(): number {
    return this.spring.target;
  }

  /** Resolves when the spring comes to rest at `target` (or is interrupted by `jump`). */
  to(target: number, config?: SpringConfig): Promise<void> {
    if (config) this.spring.config = config;
    if (isReducedMotion()) {
      this.jump(target);
      return Promise.resolve();
    }
    this.spring.setTarget(target);
    const done = new Promise<void>((resolve) => this.resolvers.push(resolve));
    this.run();
    return done;
  }

  kick(velocity: number, config?: SpringConfig): void {
    if (isReducedMotion()) return;
    if (config) this.spring.config = config;
    this.spring.impulse(velocity);
    this.run();
  }

  jump(value: number): void {
    this.cancel?.();
    this.cancel = null;
    this.spring.jump(value);
    this.render(value, 0);
    this.settle();
  }

  stop(): void {
    this.cancel?.();
    this.cancel = null;
    this.settle();
  }

  private run(): void {
    if (this.cancel) return;
    this.cancel = schedule((dt) => {
      const done = this.spring.step(dt);
      this.render(this.spring.value, this.spring.velocity);
      if (done) {
        this.cancel = null;
        this.settle();
      }
      return !done;
    });
  }

  private settle(): void {
    const resolvers = this.resolvers;
    this.resolvers = [];
    for (const resolve of resolvers) resolve();
  }
}
