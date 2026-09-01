/* Node용 최소 캔버스 셤 — analyzeRegionShot이 쓰는 getImageData / drawImage(9인자)만 구현.
   리샘플은 bilinear(브라우저 imageSmoothingQuality='high'와 완전 동일하진 않지만 측정 로직 검증엔 충분). */

class FakeContext {
  constructor(canvas) { this.canvas = canvas; this.imageSmoothingQuality = 'low'; }
  getImageData(x, y, w, h) {
    const c = this.canvas; c._ensure();
    x |= 0; y |= 0; w |= 0; h |= 0;
    const out = new Uint8ClampedArray(w * h * 4);
    for (let yy = 0; yy < h; yy++) {
      const sy = y + yy; if (sy < 0 || sy >= c.height) continue;
      const srcOff = (sy * c.width + x) * 4;
      out.set(c._data.subarray(srcOff, srcOff + w * 4), yy * w * 4);
    }
    return { data: out, width: w, height: h };
  }
  drawImage(src, sx, sy, sw, sh, dx, dy, dw, dh) {
    if (arguments.length === 3) { dx = sx; dy = sy; sx = 0; sy = 0; sw = src.width; sh = src.height; dw = sw; dh = sh; }
    const c = this.canvas; c._ensure(); src._ensure();
    const sd = src._data, SW = src.width;
    for (let yy = 0; yy < dh; yy++) {
      const fy = Math.min(sh - 1, Math.max(0, (yy + 0.5) * sh / dh - 0.5));
      const y0 = Math.floor(fy), y1 = Math.min(sh - 1, y0 + 1), wy = fy - y0;
      for (let xx = 0; xx < dw; xx++) {
        const fx = Math.min(sw - 1, Math.max(0, (xx + 0.5) * sw / dw - 0.5));
        const x0 = Math.floor(fx), x1 = Math.min(sw - 1, x0 + 1), wx = fx - x0;
        const i00 = ((sy + y0) * SW + sx + x0) * 4, i01 = ((sy + y0) * SW + sx + x1) * 4;
        const i10 = ((sy + y1) * SW + sx + x0) * 4, i11 = ((sy + y1) * SW + sx + x1) * 4;
        const o = ((dy + yy) * c.width + dx + xx) * 4;
        for (let ch = 0; ch < 4; ch++) {
          const top = sd[i00 + ch] * (1 - wx) + sd[i01 + ch] * wx;
          const bot = sd[i10 + ch] * (1 - wx) + sd[i11 + ch] * wx;
          c._data[o + ch] = top * (1 - wy) + bot * wy;
        }
      }
    }
  }
}

export class FakeCanvas {
  constructor(w = 0, h = 0) { this.width = w; this.height = h; this._data = null; this._dw = 0; this._dh = 0; }
  _ensure() {
    if (!this._data || this._dw !== this.width || this._dh !== this.height) {
      this._data = new Uint8ClampedArray(this.width * this.height * 4);
      for (let i = 3; i < this._data.length; i += 4) this._data[i] = 255;
      this._dw = this.width; this._dh = this.height;
    }
  }
  getContext() { return this._ctx || (this._ctx = new FakeContext(this)); }
}

export const createCanvas = () => new FakeCanvas();
