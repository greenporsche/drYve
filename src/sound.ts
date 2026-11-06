// Synthesized car sound (Web Audio; no recordings). Engine note from the virtual engine's rpm, an
// octave below the firing frequency (PO: the straight firing note read as whiny), and a kerb rumble
// while wheels are on a kerb. No wind/tyre noise (PO: it read as static). Browsers only allow
// audio after a user gesture, so it starts on the first key press. M mutes.
const CYLINDERS = 6; // V6: three firing pulses per crankshaft revolution
const MASTER = 0.35;
const PITCH = 0.5; // one octave down

export class CarSound {
  private ctx: AudioContext | null = null;
  private master!: GainNode;
  private engineGain!: GainNode;
  private engineOsc: OscillatorNode[] = [];
  private engineFilter!: BiquadFilterNode;
  private kerbGain!: GainNode;
  private screechGain!: GainNode;
  private screechFilter!: BiquadFilterNode;
  muted = false;
  // Last values set, for inspection in tests.
  readonly state = { running: false, firingHz: 0, engineGain: 0, kerbGain: 0, screechGain: 0 };

  constructor() {
    window.addEventListener('keydown', (e) => {
      if (e.code === 'KeyM' && !e.repeat) {
        this.muted = !this.muted;
        if (this.ctx) this.master.gain.setTargetAtTime(this.muted ? 0 : MASTER, this.ctx.currentTime, 0.05);
      }
      this.start();
    });
    // A tap or click is a user gesture too (touch screens have no keys), so it can start the sound.
    window.addEventListener('pointerdown', () => this.start());
  }

  // Esc pause: the whole audio graph stops; a key or tap while paused does not restart it.
  private paused = false;
  setPaused(paused: boolean) {
    this.paused = paused;
    if (this.ctx) void (paused ? this.ctx.suspend() : this.ctx.resume());
  }

  private start() {
    if (this.ctx) {
      if (this.ctx.state === 'suspended' && !this.paused) void this.ctx.resume();
      return;
    }
    const ctx = new AudioContext();
    this.ctx = ctx;
    if (this.paused) void ctx.suspend();
    this.master = ctx.createGain();
    this.master.gain.value = this.muted ? 0 : MASTER;
    this.master.connect(ctx.destination);

    // Engine: firing-frequency sawtooth plus a detuned octave, through a low-pass that opens
    // with throttle (a harder, brighter note on power, a duller burble off it).
    this.engineFilter = ctx.createBiquadFilter();
    this.engineFilter.type = 'lowpass';
    this.engineFilter.Q.value = 2;
    this.engineGain = ctx.createGain();
    this.engineGain.gain.value = 0;
    this.engineFilter.connect(this.engineGain).connect(this.master);
    for (const [type, mult, level] of [['sawtooth', 1, 0.5], ['square', 2, 0.18], ['sawtooth', 0.5, 0.3]] as const) {
      const o = ctx.createOscillator();
      o.type = type;
      const g = ctx.createGain();
      g.gain.value = level;
      o.connect(g).connect(this.engineFilter);
      o.start();
      (o as OscillatorNode & { mult: number }).mult = mult;
      this.engineOsc.push(o);
    }

    // Shared white-noise source for wind/tyres and the kerb rumble.
    const noise = ctx.createBufferSource();
    const buf = ctx.createBuffer(1, ctx.sampleRate * 2, ctx.sampleRate);
    const data = buf.getChannelData(0);
    for (let i = 0; i < data.length; i++) data[i] = Math.random() * 2 - 1;
    noise.buffer = buf;
    noise.loop = true;
    noise.start();
    const kerbFilter = ctx.createBiquadFilter();
    kerbFilter.type = 'lowpass';
    kerbFilter.frequency.value = 180;
    this.kerbGain = ctx.createGain();
    this.kerbGain.gain.value = 0;
    noise.connect(kerbFilter).connect(this.kerbGain).connect(this.master);
    // Tyre screech: the same noise through a narrow band-pass, louder the faster a tread slides.
    this.screechFilter = ctx.createBiquadFilter();
    this.screechFilter.type = 'bandpass';
    this.screechFilter.Q.value = 9;
    this.screechFilter.frequency.value = 1900;
    this.screechGain = ctx.createGain();
    this.screechGain.gain.value = 0;
    noise.connect(this.screechFilter).connect(this.screechGain).connect(this.master);
    this.state.running = true;
  }

  // Called every frame with the shared engine state and the car's motion.
  // slide: fastest tread sliding speed over the road (m/s); locked: a wheel is braked to a stop.
  update(rpm: number, throttle: number, speedMs: number, wheelsOnKerb: number, odometer: number, slide = 0, locked = false) {
    if (!this.ctx) return;
    const t = this.ctx.currentTime;
    const firing = (rpm / 60) * (CYLINDERS / 2) * PITCH;
    for (const o of this.engineOsc) o.frequency.setTargetAtTime(firing * (o as OscillatorNode & { mult: number }).mult, t, 0.02);
    this.engineFilter.frequency.setTargetAtTime(400 + throttle * 2200 + rpm * 0.06, t, 0.05);
    const engineGain = 0.18 + throttle * 0.32;
    this.engineGain.gain.setTargetAtTime(engineGain, t, 0.05);
    const v = Math.abs(speedMs);
    // Kerb rumble pulses at the ridge rate (one ridge per metre, as the kerb geometry).
    const pulse = Math.sin(odometer * Math.PI * 2) > 0 ? 1 : 0.3;
    const kerbGain = wheelsOnKerb > 0 ? Math.min(1, 0.25 + v / 40) * 0.9 * pulse : 0;
    this.kerbGain.gain.setTargetAtTime(kerbGain, t, 0.008);
    // Screech from 2.5 m/s of sliding; a locked wheel squeals higher than a spinning one.
    const screechGain = Math.min(1, Math.max(0, (slide - 2.5) / 12)) * 0.9;
    this.screechGain.gain.setTargetAtTime(screechGain, t, 0.03);
    this.screechFilter.frequency.setTargetAtTime((locked ? 2600 : 1700) + Math.min(600, slide * 15), t, 0.05);
    Object.assign(this.state, { firingHz: Math.round(firing), engineGain: +engineGain.toFixed(3), kerbGain: +kerbGain.toFixed(3), screechGain: +screechGain.toFixed(3) });
  }
}
