export class Time {
  constructor() {
    this.elapsed = 0;
    this.dt = 0;
    this.maxDt = 1 / 30;
    this.fps = 0;
    this._acc = 0;
    this._n = 0;
    this._last = performance.now() / 1000;
  }
  tick() {
    const now = performance.now() / 1000;
    let raw = now - this._last; this._last = now;
    if (raw < 0) raw = 0;
    this.dt = Math.min(raw, this.maxDt);
    this.dt *= (this.scale ?? 1);
    this.elapsed += this.dt;
    this._acc += raw; this._n++;
    if (this._acc >= 0.4) { this.fps = this._n / this._acc; this._acc = 0; this._n = 0; }
    return this.dt;
  }
}
