/* 모의 사용자 집단 시뮬레이터 — A/B/C 배분 튜닝용
   ------------------------------------------------------------------
   실측 런로그가 쌓이기 전까지, 문헌 프라이어(engine/SCIENCE.md)로 구성한 가상 사용자
   집단에서 판정 분포를 재고 목표 배분(대표 결정 2026-09-02: A20/B50/C30)에 맞게
   CAL(troubleMin·abTilt)을 탐색한다.

   ⚠️ 가정 기반이다 — 실기기 런로그가 오면 calibrate.mjs(--target-c)로 재조정할 것.

   집단 가정 (근거: SCIENCE.md §2):
   - 피부 상태: 지성계 57% (oilyMild 20 + oily 20 + 지성+여드름 17), 보통 18%,
     건성계 25% (dry 12 + veryDry 5 + 건성+민감붉음 8)  ← Baumann 20대 남성 O 57%
   - 설문 응답: 25%는 무신호 답(자가인식 낮음 — "모른다" 21% 문헌), 15%는 완전 랜덤,
     나머지는 자기 상태와 일치하는 답
   - 촬영 조건: base 40% / dark20 15% / noisy 15% / bright20·warmWB·tiltLight 각 10%

   사용:
     node test/harness/population.mjs            # 현재 CAL로 분포 출력
     node test/harness/population.mjs --search   # troubleMin×abTilt 격자 탐색 → 목표 근접값 제안 */
import * as E from '../../engine/bfm-skin-engine.js';
import { createCanvas } from './fakecanvas.mjs';
import { PROFILES, TRANSFORMS, makeRegion, rng } from './synth.mjs';

E.configure({ createCanvas });
const SEARCH = process.argv.includes('--search');
const TARGET = { A: 0.20, B: 0.50, C: 0.30 };

/* 상태 분포 (합=1) */
const POP = [
  ['oilyMild', 0.20, { o: 1, d: 0.05, a: 0.15 }],
  ['oily', 0.20, { o: 1, d: 0.05, a: 0.15 }],
  ['trouble', 0.17, { o: 0.8, d: 0.05, a: 1 }],   // 지성+여드름
  ['normal', 0.18, { o: 0.25, d: 0.25, a: 0.15 }],
  ['dry', 0.12, { o: 0.05, d: 1, a: 0.1 }],
  ['veryDry', 0.05, { o: 0.02, d: 1, a: 0.1 }],
  ['dryRed', 0.08, { o: 0.05, d: 0.9, a: 0.5 }],  // 건성+민감붉음
];
const TF_POP = [['base', 0.40], ['dark20', 0.15], ['noisy', 0.15], ['bright20', 0.10], ['warmWB', 0.10], ['tiltLight', 0.10]];

/* 1) 사진 풀 사전 계산 — 프로필×촬영조건×시드 2개 */
console.error('사진 풀 계산 중…');
const pool = {};
for (const [pname] of POP) {
  pool[pname] = [];
  for (const [tname] of TF_POP) for (const seed of [0, 1]) {
    const rd = {};
    for (const rk of ['tzone', 'cheek', 'nose'])
      rd[rk] = E.analyzeRegionShot(TRANSFORMS[tname](makeRegion(PROFILES[pname][rk], rk, 11 + seed * 7)), rk);
    pool[pname].push({ tname, photo: E.combineRegions(rd) });
  }
}

/* 2) 사용자 샘플 — (프로필, 사진, 설문답) N명. 설문은 fuse 단계에서 재사용 가능하게 Sv로 저장 */
const N = 20000;
const r = rng(2026);
const pickIdx = (weights) => { let x = r(); for (let i = 0; i < weights.length; i++) { x -= weights[i]; if (x <= 0) return i; } return weights.length - 1; };
const users = [];
for (let i = 0; i < N; i++) {
  const [pname, , axes] = POP[pickIdx(POP.map(e => e[1]))];
  const tname = TF_POP[pickIdx(TF_POP.map(e => e[1]))][0];
  const entry = pool[pname].filter(p => p.tname === tname)[(r() * 2) | 0] || pool[pname][0];
  const Q = E.buildSurveyQuestions(entry.photo);
  const ans = Q.map(q => {
    if (r() < 0.15) return (r() * q.opts.length) | 0;           // 완전 랜덤(응답 노이즈)
    if (r() < 0.25 / 0.85) {                                     // 무신호 답(자가인식 낮음)
      let best = 0, bs = 1e9; q.opts.forEach((o, j) => { const s = o.o + o.d + o.a; if (s < bs) { bs = s; best = j; } }); return best;
    }
    let best = 0, bs = -1e9; q.opts.forEach((o, j) => {          // 상태 일치 답
      const s = o.o * axes.o + o.d * axes.d + o.a * axes.a - 0.05 * (o.o + o.d + o.a === 0 ? 1 : 0) + r() * 0.3;
      if (s > bs) { bs = s; best = j; } });
    return best;
  });
  users.push({ Sv: E.scoreSurvey(Q, ans), photo: entry.photo });
}

/* 3) 분포 계산 (fuse만 다시 돌므로 빠름 — CAL 탐색 가능) */
function dist() {
  const c = [0, 0, 0];
  for (const u of users) c[E.fuse(u.Sv, u.photo).primary]++;
  return { B: c[0] / N, A: c[1] / N, C: c[2] / N };
}
const fmt = d => `A ${(d.A * 100).toFixed(1)}% / B ${(d.B * 100).toFixed(1)}% / C ${(d.C * 100).toFixed(1)}%`;

console.log('현재 CAL (troubleMin=' + E.CAL.troubleMin + ', abTilt=' + (E.CAL.abTilt ?? 0) + '):', fmt(dist()));

if (SEARCH) {
  console.log('\n격자 탐색 (목표 A20/B50/C30):');
  let best = null;
  for (const tm of [0.26, 0.265, 0.27, 0.275]) {
    for (const tilt of [0.10, 0.12, 0.14, 0.16]) {
      E.CAL.troubleMin = tm; E.CAL.abTilt = tilt;
      const d = dist();
      const err = Math.abs(d.A - TARGET.A) + Math.abs(d.B - TARGET.B) + Math.abs(d.C - TARGET.C);
      if (!best || err < best.err) best = { tm, tilt, d, err };
      console.log(`  troubleMin ${tm.toFixed(2)} · abTilt ${tilt.toFixed(2)} → ${fmt(d)}  (오차 ${(err * 100).toFixed(1)}pp)`);
    }
  }
  console.log('\n최적:', `troubleMin ${best.tm} · abTilt ${best.tilt} → ${fmt(best.d)}`);
}
