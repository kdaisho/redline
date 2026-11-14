/**
 * A stand-in AudioContext for tests (Node has no Web Audio). It makes no sound;
 * it checks everything that is scheduled on it and collects what would have
 * been a silent bug or an exception in a browser:
 *   - a non-finite time or value,
 *   - a time in the past,
 *   - an exponential ramp to (or from) zero or below — Web Audio throws on that,
 *   - a `setTargetAtTime` with a time constant ≤ 0,
 *   - a source stopped before it starts.
 */

export class StubParam {
  value: number;
  /** Last value scheduled (what an exponential ramp would start from). */
  private last: number;

  constructor(
    private readonly owner: StubContext,
    private readonly name: string,
    initial: number,
  ) {
    this.value = initial;
    this.last = initial;
  }

  private check(method: string, value: number, time: number): void {
    const at = `${this.name}.${method}(${value}, ${time})`;
    if (!Number.isFinite(value)) this.owner.problems.push(`${at}: non-finite value`);
    if (!Number.isFinite(time)) this.owner.problems.push(`${at}: non-finite time`);
    else if (time < this.owner.currentTime - 1e-9) this.owner.problems.push(`${at}: time in the past (now ${this.owner.currentTime})`);
    this.owner.scheduled++;
  }

  setValueAtTime(value: number, time: number): this {
    this.check('setValueAtTime', value, time);
    this.last = value;
    return this;
  }

  linearRampToValueAtTime(value: number, time: number): this {
    this.check('linearRampToValueAtTime', value, time);
    this.last = value;
    return this;
  }

  exponentialRampToValueAtTime(value: number, time: number): this {
    this.check('exponentialRampToValueAtTime', value, time);
    if (!(value > 0)) this.owner.problems.push(`${this.name}: exponential ramp to ${value}`);
    if (!(this.last > 0)) this.owner.problems.push(`${this.name}: exponential ramp from ${this.last}`);
    this.last = value;
    return this;
  }

  setTargetAtTime(value: number, time: number, timeConstant: number): this {
    this.check('setTargetAtTime', value, time);
    if (!(timeConstant > 0) || !Number.isFinite(timeConstant)) this.owner.problems.push(`${this.name}: time constant ${timeConstant}`);
    return this;
  }

  cancelScheduledValues(time: number): this {
    if (!Number.isFinite(time)) this.owner.problems.push(`${this.name}.cancelScheduledValues(${time})`);
    return this;
  }
}

/** Any node: connectable, with whichever params its kind has. */
export class StubNode {
  onended: (() => void) | null = null;
  type = '';
  buffer: unknown = null;
  loop = false;
  curve: Float32Array | null = null;
  private startedAt: number | null = null;

  readonly gain: StubParam;
  readonly frequency: StubParam;
  readonly detune: StubParam;
  readonly Q: StubParam;
  readonly delayTime: StubParam;
  readonly threshold: StubParam;
  readonly knee: StubParam;
  readonly ratio: StubParam;
  readonly attack: StubParam;
  readonly release: StubParam;

  constructor(
    private readonly owner: StubContext,
    readonly kind: string,
  ) {
    const p = (name: string, initial: number): StubParam => new StubParam(owner, `${kind}.${name}`, initial);
    this.gain = p('gain', 1);
    this.frequency = p('frequency', kind === 'biquad' ? 350 : 440);
    this.detune = p('detune', 0);
    this.Q = p('Q', 1);
    this.delayTime = p('delayTime', 0);
    this.threshold = p('threshold', -24);
    this.knee = p('knee', 30);
    this.ratio = p('ratio', 12);
    this.attack = p('attack', 0.003);
    this.release = p('release', 0.25);
  }

  connect<T>(target: T): T {
    this.owner.connections++;
    return target;
  }

  disconnect(): void {
    // nothing to release
  }

  setPeriodicWave(): void {
    this.type = 'custom';
  }

  start(when = 0, offset = 0): void {
    if (!Number.isFinite(when) || !Number.isFinite(offset)) this.owner.problems.push(`${this.kind}.start(${when}, ${offset}): non-finite`);
    else if (when < this.owner.currentTime - 1e-9) this.owner.problems.push(`${this.kind}.start(${when}): in the past (now ${this.owner.currentTime})`);
    if (this.startedAt !== null) this.owner.problems.push(`${this.kind}: started twice`);
    this.startedAt = when;
    this.owner.sources++;
    this.owner.lastStart = Math.max(this.owner.lastStart, when);
  }

  stop(when = 0): void {
    if (!Number.isFinite(when)) this.owner.problems.push(`${this.kind}.stop(${when}): non-finite`);
    else if (this.startedAt !== null && when < this.startedAt) this.owner.problems.push(`${this.kind}: stops (${when}) before it starts (${this.startedAt})`);
    this.owner.lastStop = Math.max(this.owner.lastStop, when);
  }
}

export class StubContext {
  currentTime: number;
  readonly sampleRate = 8000; // small: the noise buffers are filled for real
  readonly destination: StubNode;
  /** Everything that would have been wrong in a real context. Empty = clean. */
  problems: string[] = [];
  /** AudioParam events scheduled. */
  scheduled = 0;
  /** Oscillators / buffer sources started. */
  sources = 0;
  connections = 0;
  lastStart = -Infinity;
  lastStop = -Infinity;

  constructor(currentTime = 0) {
    this.currentTime = currentTime;
    this.destination = new StubNode(this, 'destination');
  }

  createGain(): StubNode {
    return new StubNode(this, 'gain');
  }
  createOscillator(): StubNode {
    return new StubNode(this, 'oscillator');
  }
  createBiquadFilter(): StubNode {
    return new StubNode(this, 'biquad');
  }
  createBufferSource(): StubNode {
    return new StubNode(this, 'bufferSource');
  }
  createDynamicsCompressor(): StubNode {
    return new StubNode(this, 'compressor');
  }
  createWaveShaper(): StubNode {
    return new StubNode(this, 'waveShaper');
  }
  createDelay(): StubNode {
    return new StubNode(this, 'delay');
  }
  createPeriodicWave(real: Float32Array, imag: Float32Array): { real: Float32Array; imag: Float32Array } {
    for (const v of real) if (!Number.isFinite(v)) this.problems.push('periodic wave: non-finite coefficient');
    return { real, imag };
  }
  createBuffer(_channels: number, length: number): { getChannelData(ch: number): Float32Array } {
    const data = new Float32Array(length);
    return { getChannelData: () => data };
  }

  /** The stub as the context type the engines take. */
  asContext(): BaseAudioContext {
    return this as unknown as BaseAudioContext;
  }
  /** A node of the stub as the destination type the engines take. */
  node(n: StubNode = this.destination): AudioNode {
    return n as unknown as AudioNode;
  }
}
