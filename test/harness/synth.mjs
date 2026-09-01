/* 합성 부위 사진 생성기 + 촬영 조건 변형(조명·WB·노이즈·블러·프레이밍)
   실사진 대체가 아니라 "같은 피부, 다른 촬영 조건"에서 엔진 판정이 얼마나 흔들리는지
   재현 가능하게 재는 용도. 실기기 9회 측정(ROLLOUT 3단계)과 상호 보완. */
import { FakeCanvas } from './fakecanvas.mjs';

/* 결정적 RNG (mulberry32) — 같은 시드는 항상 같은 이미지 */
export function rng(seed) { let a = seed >>> 0; return () => { a |= 0; a = a + 0x6D2B79F5 | 0; let t = Math.imul(a ^ a >>> 15, 1 | a); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; }; }
const gauss = (r) => (r() + r() + r() + r() - 2) * Math.sqrt(3); // 대략 N(0,1)

export const W = 720, H = 960;

/* 피부 프로필 → 부위별 렌더 파라미터
   shineArea: 스페큘러(거의 흰색) 커버리지, redArea: 붉은 블로치 커버리지, poreDen: 모공 점 밀도 */
export const PROFILES = {
  veryDry: { tzone: { shineArea: 0.00, redArea: 0.005, poreDen: 0.001 }, cheek: { shineArea: 0.00, redArea: 0.005, poreDen: 0.001 }, nose: { shineArea: 0.00, redArea: 0.005, poreDen: 0.002 } },
  dry:     { tzone: { shineArea: 0.01, redArea: 0.01, poreDen: 0.002 }, cheek: { shineArea: 0.005, redArea: 0.01, poreDen: 0.001 }, nose: { shineArea: 0.01, redArea: 0.01, poreDen: 0.003 } },
  normal:  { tzone: { shineArea: 0.03, redArea: 0.01, poreDen: 0.004 }, cheek: { shineArea: 0.015, redArea: 0.01, poreDen: 0.002 }, nose: { shineArea: 0.03, redArea: 0.01, poreDen: 0.006 } },
  oilyMild:{ tzone: { shineArea: 0.07, redArea: 0.01, poreDen: 0.008 }, cheek: { shineArea: 0.02, redArea: 0.01, poreDen: 0.003 }, nose: { shineArea: 0.07, redArea: 0.01, poreDen: 0.012 } },
  oily:    { tzone: { shineArea: 0.14, redArea: 0.01, poreDen: 0.012 }, cheek: { shineArea: 0.03, redArea: 0.01, poreDen: 0.004 }, nose: { shineArea: 0.13, redArea: 0.015, poreDen: 0.018 } },
  trouble: { tzone: { shineArea: 0.06, redArea: 0.05, poreDen: 0.008 }, cheek: { shineArea: 0.025, redArea: 0.10, poreDen: 0.005 }, nose: { shineArea: 0.06, redArea: 0.05, poreDen: 0.010 } },
  dryRed:  { tzone: { shineArea: 0.005, redArea: 0.04, poreDen: 0.002 }, cheek: { shineArea: 0.005, redArea: 0.08, poreDen: 0.002 }, nose: { shineArea: 0.005, redArea: 0.03, poreDen: 0.003 } },
};

const SKIN_BASE = [200, 150, 120]; // isFaceSkin 통과하는 무난한 피부톤

/* 부위 사진 한 장 생성 */
export function makeRegion(params, region, seed = 1) {
  const r = rng(seed);
  const c = new FakeCanvas(W, H); c._ensure(); const d = c._data;
  const noiseSigma = 5;
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const i = (y * W + x) * 4;
    // 완만한 자연 음영(가장자리 살짝 어둡게) + 미세 피부결 노이즈
    const vign = 1 - 0.10 * Math.hypot((x / W - 0.5), (y / H - 0.5));
    const tex = gauss(r) * noiseSigma;
    d[i] = SKIN_BASE[0] * vign + tex; d[i + 1] = SKIN_BASE[1] * vign + tex * 0.9; d[i + 2] = SKIN_BASE[2] * vign + tex * 0.8; d[i + 3] = 255;
  }
  // 스페큘러(광택): 타원 패치를 흰색 쪽으로 블렌드 — T존은 세로 밴드 위주
  paintPatches(d, r, params.shineArea, region === 'tzone' ? 'band' : 'spots', [255, 255, 250], 0.85);
  // 붉은기: 블로치를 붉은색 쪽으로
  paintPatches(d, r, params.redArea, 'spots', [214, 105, 95], 0.55);
  // 모공: 어두운 점
  const nPores = Math.round(params.poreDen * W * H / 30);
  for (let k = 0; k < nPores; k++) {
    const px = 20 + (r() * (W - 40)) | 0, py = 20 + (r() * (H - 40)) | 0, rad = 1 + r() * 1.6, dep = 20 + r() * 18;
    for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) {
      const dist = Math.hypot(dx, dy); if (dist > rad + 0.8) continue;
      const f = Math.max(0, 1 - dist / (rad + 0.8)) * dep, i = ((py + dy) * W + px + dx) * 4;
      d[i] -= f; d[i + 1] -= f; d[i + 2] -= f;
    }
  }
  return c;
}
function paintPatches(d, r, areaFrac, mode, color, strength) {
  if (areaFrac <= 0) return;
  const total = areaFrac * W * H; let painted = 0; let guard = 0;
  while (painted < total && guard++ < 400) {
    let cx, cy, rx, ry;
    if (mode === 'band') { cx = W * (0.42 + r() * 0.16); cy = H * (0.15 + r() * 0.6); rx = W * (0.03 + r() * 0.05); ry = H * (0.05 + r() * 0.10); }
    else { cx = W * (0.15 + r() * 0.7); cy = H * (0.15 + r() * 0.7); rx = W * (0.02 + r() * 0.05); ry = rx * (0.7 + r() * 0.6); }
    for (let y = Math.max(0, cy - ry | 0); y < Math.min(H, cy + ry | 0); y++)
      for (let x = Math.max(0, cx - rx | 0); x < Math.min(W, cx + rx | 0); x++) {
        const e = ((x - cx) / rx) ** 2 + ((y - cy) / ry) ** 2; if (e > 1) continue;
        const f = strength * (1 - e) ** 1.5, i = (y * W + x) * 4;
        d[i] += (color[0] - d[i]) * f; d[i + 1] += (color[1] - d[i + 1]) * f; d[i + 2] += (color[2] - d[i + 2]) * f;
      }
    painted += Math.PI * rx * ry * 0.5;
  }
}

/* ===== 촬영 조건 변형 ===== */
function mapPixels(c, fn) { c._ensure(); const d = c._data, out = new FakeCanvas(c.width, c.height); out._ensure();
  for (let i = 0; i < d.length; i += 4) { const [r, g, b] = fn(d[i], d[i + 1], d[i + 2], i); out._data[i] = r; out._data[i + 1] = g; out._data[i + 2] = b; out._data[i + 3] = 255; }
  return out; }
export const TRANSFORMS = {
  base: c => c,
  dark20: c => mapPixels(c, (r, g, b) => [r * 0.8, g * 0.8, b * 0.8]),
  dark35: c => mapPixels(c, (r, g, b) => [r * 0.65, g * 0.65, b * 0.65]),
  bright20: c => mapPixels(c, (r, g, b) => [r * 1.2, g * 1.2, b * 1.2]),
  gammaLo: c => mapPixels(c, (r, g, b) => [255 * (r / 255) ** 1.18, 255 * (g / 255) ** 1.18, 255 * (b / 255) ** 1.18]),
  gammaHi: c => mapPixels(c, (r, g, b) => [255 * (r / 255) ** 0.85, 255 * (g / 255) ** 0.85, 255 * (b / 255) ** 0.85]),
  warmWB: c => mapPixels(c, (r, g, b) => [r * 1.08, g, b * 0.92]),
  coolWB: c => mapPixels(c, (r, g, b) => [r * 0.93, g, b * 1.07]),
  noisy: (c) => { const rr = rng(99); return mapPixels(c, (r, g, b) => { const n = gauss(rr) * 7; return [r + n, g + n * 0.9, b + n * 0.8]; }); },
  blur: c => boxBlur(c, 2),
  tiltLight: c => { c._ensure(); return mapPixels(c, (r, g, b, i) => { const x = (i / 4) % c.width; const f = 0.86 + 0.28 * (x / c.width); return [r * f, g * f, b * f]; }); },
  zoomIn: c => cropResize(c, 0.88), // 더 가까이 찍음
  shift: c => shiftContent(c, 0.05, 0.04), // 프레이밍 어긋남
};
function boxBlur(c, rad) { c._ensure(); const d = c._data, w = c.width, h = c.height, out = new FakeCanvas(w, h); out._ensure();
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) { let r = 0, g = 0, b = 0, n = 0;
    for (let dy = -rad; dy <= rad; dy++) { const yy = y + dy; if (yy < 0 || yy >= h) continue;
      for (let dx = -rad; dx <= rad; dx++) { const xx = x + dx; if (xx < 0 || xx >= w) continue; const i = (yy * w + xx) * 4; r += d[i]; g += d[i + 1]; b += d[i + 2]; n++; } }
    const o = (y * w + x) * 4; out._data[o] = r / n; out._data[o + 1] = g / n; out._data[o + 2] = b / n; out._data[o + 3] = 255; }
  return out; }
function cropResize(c, frac) { const out = new FakeCanvas(c.width, c.height); const sw = c.width * frac | 0, sh = c.height * frac | 0;
  out.getContext().drawImage(c, (c.width - sw) / 2 | 0, (c.height - sh) / 2 | 0, sw, sh, 0, 0, c.width, c.height); return out; }
function shiftContent(c, fx, fy) { const out = new FakeCanvas(c.width, c.height); const dx = c.width * fx | 0, dy = c.height * fy | 0;
  const sw = c.width - dx, sh = c.height - dy;
  out.getContext().drawImage(c, dx, dy, sw, sh, 0, 0, c.width, c.height); return out; }
