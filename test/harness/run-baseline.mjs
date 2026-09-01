/* 회귀·일관성 하니스 — 엔진(engine/bfm-skin-engine.js)을 직접 import해서
   1) 설문 전수 스윕(A/B/C 분포·경계 밀집도)
   2) 합성 사진 프로필 × 촬영 변형 → 판정 일관성·지수 흔들림
   3) 프로필 × 설문 페르소나 → 최종 타입 매트릭스
   를 측정하고 test/baseline/<라벨>.json 으로 남긴다.

   사용: node test/harness/run-baseline.mjs [라벨]   (기본 라벨: 현재 시각) */
import * as E from '../../engine/bfm-skin-engine.js';
import { createCanvas } from './fakecanvas.mjs';
import { PROFILES, TRANSFORMS, makeRegion } from './synth.mjs';
import fs from 'node:fs';
import path from 'node:path';
import url from 'node:url';

E.configure({ createCanvas });
const HERE = path.dirname(url.fileURLToPath(import.meta.url));
const OUT_DIR = path.join(HERE, '..', 'baseline');
fs.mkdirSync(OUT_DIR, { recursive: true });
const LABEL = process.argv[2] || new Date().toISOString().replace(/[:T]/g, '-').slice(0, 16);

const res = { label: LABEL, engineVersion: E.ENGINE_VERSION, when: new Date().toISOString() };

/* ───────── 1. 설문 전수 스윕 (사진 없음) ───────── */
{
  const Q = E.buildSurveyQuestions(null); // hint 없음 → def 포커스, 8문항
  const counts = [0, 0, 0]; let n = 0, nearBoundary = 0, troubleCliff = 0;
  const lens = Q.map(q => q.opts.length);
  const idx = new Array(Q.length).fill(0);
  for (; ;) {
    const Sv = E.scoreSurvey(Q, idx);
    const r = E.fuse(Sv, null);
    counts[r.primary]++; n++;
    const s = [...r.F].sort((a, b) => b - a); if (s[0] - s[1] < 0.03) nearBoundary++;
    if (Math.abs(r.F[2] - E.CAL.troubleMin) < 0.02) troubleCliff++;
    let k = Q.length - 1; while (k >= 0 && ++idx[k] >= lens[k]) { idx[k] = 0; k--; } if (k < 0) break;
  }
  res.surveySweep = {
    total: n,
    dist: { oily_B: counts[0] / n, dry_A: counts[1] / n, trouble_C: counts[2] / n },
    nearBoundaryFrac: nearBoundary / n,      // 1·2위 격차 < 0.03 — 답 하나로 타입이 뒤집힐 수 있는 조합 비율
    troubleCliffFrac: troubleCliff / n,      // F[2]가 troubleMin ±0.02 안 — C 경계에 밀집한 조합 비율
  };
  console.log('[1] 설문 전수 스윕', n, '조합 → A/B/C =',
    (counts[1] / n * 100).toFixed(1) + '% /', (counts[0] / n * 100).toFixed(1) + '% /', (counts[2] / n * 100).toFixed(1) + '%',
    '· 경계밀집', (nearBoundary / n * 100).toFixed(1) + '%', '· C절벽', (troubleCliff / n * 100).toFixed(1) + '%');
}

/* ───────── 설문 페르소나 ───────── */
function persona(kind) {
  return (q) => { // 문항별 선택지 인덱스
    let best = 0, bestScore = -1e9;
    q.opts.forEach((o, j) => {
      let s;
      if (kind === 'neutral') s = -(o.o + o.d + o.a) * 10 - j * 0.01;   // 무신호 답 선호
      else if (kind === 'oily') s = o.o * 2 - o.d - o.a;
      else if (kind === 'dry') s = o.d * 2 - o.o - o.a;
      else if (kind === 'acne') s = o.a * 2 - o.o - o.d;
      else if (kind === 'oilyAcne') s = o.o + o.a * 1.5 - o.d;
      if (s > bestScore) { bestScore = s; best = j; }
    });
    return best;
  };
}
const PERSONAS = ['neutral', 'oily', 'dry', 'acne', 'oilyAcne'];
function runSurvey(photo, kind) {
  const Q = E.buildSurveyQuestions(photo);
  const pick = persona(kind);
  const ans = Q.map(q => pick(q));
  return E.scoreSurvey(Q, ans);
}

/* ───────── 2. 사진 프로필 × 변형 → 일관성 ───────── */
{
  const out = {}; const t0 = Date.now();
  for (const [pname, prof] of Object.entries(PROFILES)) {
    // 프로필당 기본 3부위 생성(시드 고정)
    const baseImgs = { tzone: makeRegion(prof.tzone, 'tzone', 11), cheek: makeRegion(prof.cheek, 'cheek', 22), nose: makeRegion(prof.nose, 'nose', 33) };
    const variants = {};
    for (const [tname, tf] of Object.entries(TRANSFORMS)) {
      const regionData = {};
      for (const rk of ['tzone', 'cheek', 'nose']) regionData[rk] = E.analyzeRegionShot(tf(baseImgs[rk]), rk);
      const photo = E.combineRegions(regionData);
      variants[tname] = {
        raw: { tzShine: +regionData.tzone.shine.toFixed(4), chShine: +regionData.cheek.shine.toFixed(4), noseShine: +regionData.nose.shine.toFixed(4), chRed: +regionData.cheek.redness.toFixed(4), nosePore: +regionData.nose.poreDen.toFixed(4), q: +photo.q.toFixed(3) },
        Sp: photo.Sp.map(x => +x.toFixed(4)), idx: photo.idx, q: +photo.q.toFixed(3),
        types: Object.fromEntries(PERSONAS.map(k => { const r = E.fuse(runSurvey(photo, k), photo); return [k, r.primary]; })),
        margins: Object.fromEntries(PERSONAS.map(k => { const r = E.fuse(runSurvey(photo, k), photo); const srt = [...r.F].sort((a, b) => b - a); return [k, +(srt[0] - srt[1]).toFixed(4)]; })),
      };
    }
    // 일관성: 각 페르소나에서 base 타입과 같은 변형 비율
    const names = Object.keys(TRANSFORMS);
    const agree = {}; let agreeSum = 0;
    for (const k of PERSONAS) {
      const bt = variants.base.types[k];
      const a = names.filter(nm => variants[nm].types[k] === bt).length / names.length;
      agree[k] = +a.toFixed(3); agreeSum += a;
    }
    const spread = axis => { const vals = names.map(nm => variants[nm].Sp[axis]); return +(Math.max(...vals) - Math.min(...vals)).toFixed(4); };
    const idxSpread = key => { const vals = names.map(nm => variants[nm].idx[key]).filter(v => v != null); return vals.length ? Math.max(...vals) - Math.min(...vals) : null; };
    /* 재촬영 일치율(핵심 지표): 임의의 두 촬영 조건 쌍에서 같은 타입이 나오는 비율 — 사용자는 base와
       비교하는 게 아니라 아무 두 번을 찍어 비교한다. + 경계 마진(<0.03이면 답 하나로 뒤집힘) 비율 */
    let paSum = 0, mSmall = 0, mTot = 0;
    for (const k of PERSONAS) {
      const ts = names.map(nm => variants[nm].types[k]);
      let same = 0, tot = 0;
      for (let i = 0; i < ts.length; i++) for (let j = i + 1; j < ts.length; j++) { tot++; if (ts[i] === ts[j]) same++; }
      paSum += same / tot;
      for (const nm of names) { mTot++; if (variants[nm].margins[k] < 0.03) mSmall++; }
    }
    out[pname] = {
      retakeAgree: +(paSum / PERSONAS.length).toFixed(3), marginSmallFrac: +(mSmall / mTot).toFixed(3),
      agree, agreeMean: +(agreeSum / PERSONAS.length).toFixed(3),
      SpSpread: { oily: spread(0), dry: spread(1), acne: spread(2) },
      idxSpread: { tzOil: idxSpread('tzOil'), pore: idxSpread('pore'), red: idxSpread('red') },
      variants,
    };
    console.log('[2]', pname.padEnd(8), '재촬영쌍 일치', out[pname].retakeAgree, '· 경계마진<0.03', out[pname].marginSmallFrac, '· base대비 일치', out[pname].agreeMean, '· idx흔들림', JSON.stringify(out[pname].idxSpread));
  }
  res.photoConsistency = out;
  const all = Object.values(out);
  res.photoConsistencySummary = {
    agreeMean: +(all.reduce((s, p) => s + p.agreeMean, 0) / all.length).toFixed(3),
    retakeAgreeMean: +(all.reduce((s, p) => s + p.retakeAgree, 0) / all.length).toFixed(3),
    marginSmallMean: +(all.reduce((s, p) => s + p.marginSmallFrac, 0) / all.length).toFixed(3),
    worstProfile: Object.entries(out).sort((a, b) => a[1].retakeAgree - b[1].retakeAgree)[0][0],
    tzOilIdxSpreadMax: Math.max(...all.map(p => p.idxSpread.tzOil ?? 0)),
  };
  console.log('[2] 재촬영쌍 일치 평균', res.photoConsistencySummary.retakeAgreeMean, '· base대비', res.photoConsistencySummary.agreeMean, '· 최악(재촬영)', res.photoConsistencySummary.worstProfile, '·', ((Date.now() - t0) / 1000).toFixed(1) + 's');
}

/* ───────── 3. 프로필 × 페르소나 → 최종 타입 매트릭스 (base 변형만) ───────── */
{
  const matrix = {};
  for (const [pname, prof] of Object.entries(PROFILES)) {
    const regionData = {};
    for (const rk of ['tzone', 'cheek', 'nose']) regionData[rk] = E.analyzeRegionShot(makeRegion(prof[rk], rk, 11), rk);
    const photo = E.combineRegions(regionData);
    matrix[pname] = Object.fromEntries(PERSONAS.map(k => {
      const r = E.fuse(runSurvey(photo, k), photo);
      return [k, ['B지성', 'A건성', 'C트러블'][r.primary] + (r.band === '낮은 확신' ? '(낮)' : '')];
    }));
  }
  res.typeMatrix = matrix;
  console.log('[3] 타입 매트릭스'); console.table(matrix);
}

/* ───────── 4. 강화 검증 — 홍조 구분·오염원 제외·연사 ───────── */
{
  const out = {};
  // 4a. 넓은 홍조(flushed) — 점상 트러블이 아니므로 C가 되면 안 되고 '홍조 주의' 플래그가 떠야 함
  {
    const prof = { tzone: { shineArea: 0.01, redArea: 0.005, poreDen: 0.002 },
      cheek: { shineArea: 0.005, redArea: 0.005, poreDen: 0.002, flushArea: 0.30 },
      nose: { shineArea: 0.01, redArea: 0.005, poreDen: 0.003 } };
    const rd = {}; for (const rk of ['tzone', 'cheek', 'nose']) rd[rk] = E.analyzeRegionShot(makeRegion(prof[rk], rk, 44), rk);
    const photo = E.combineRegions(rd);
    const r = E.fuse(runSurvey(photo, 'neutral'), photo);
    out.flushed = { cheek: { redness: +rd.cheek.redness.toFixed(3), redSpot: +rd.cheek.redSpot.toFixed(3), redFlush: +rd.cheek.redFlush.toFixed(3) },
      type: ['B지성', 'A건성', 'C트러블'][r.primary], flags: r.flags, SpAcne: +photo.Sp[2].toFixed(3) };
    console.log('[4a] flushed(넓은 홍조):', JSON.stringify(out.flushed));
  }
  // 4b. 오염원(눈썹·눈·입술)이 프레임에 들어온 사진 — 키포인트 ROI·제외 원이 측정 순도를 회복하는가
  {
    const base = { shineArea: 0.02, redArea: 0.01, poreDen: 0.003 };
    const clean = E.analyzeRegionShot(makeRegion(base, 'cheek', 55), 'cheek');
    const dirtyImg = makeRegion({ ...base, features: true }, 'cheek', 55);
    const dirty = E.analyzeRegionShot(dirtyImg, 'cheek');
    const ex = [ // 합성 특징 위치(synth.mjs) 그대로 — 실제로는 촬영 순간 BlazeFace 키포인트가 제공
      { x: 0.30 * 720, y: 0.28 * 960, r: 0.11 * 720 }, { x: 0.70 * 720, y: 0.28 * 960, r: 0.11 * 720 },
      { x: 0.50 * 720, y: 0.74 * 960, r: 0.14 * 720 }];
    const fixed = E.analyzeRegionShot(dirtyImg, 'cheek', { exclude: ex });
    const dev = (m) => ({ red: +Math.abs(m.redSpot - clean.redSpot).toFixed(4), pore: +Math.abs(m.poreDen - clean.poreDen).toFixed(4), shine: +Math.abs(m.shine - clean.shine).toFixed(4) });
    out.contamination = { cleanRef: { redSpot: +clean.redSpot.toFixed(4), poreDen: +clean.poreDen.toFixed(4), shine: +clean.shine.toFixed(4) },
      dirtyDeviation: dev(dirty), withExcludeDeviation: dev(fixed) };
    console.log('[4b] 오염원 편차 — 제외 전:', JSON.stringify(out.contamination.dirtyDeviation), '→ 제외 후:', JSON.stringify(out.contamination.withExcludeDeviation));
  }
  // 4c. 연사(3장) 중앙값 — 노이즈 사진에서 단일 촬영 대비 흔들림 감소
  {
    const prof = PROFILES.normal;
    const cleanRef = {}; for (const rk of ['tzone', 'cheek', 'nose']) cleanRef[rk] = E.analyzeRegionShot(makeRegion(prof[rk], rk, 11), rk);
    const single = [], burst = [];
    for (let t = 0; t < 6; t++) {
      const shots = [0, 1, 2].map(k => E.analyzeRegionShot(TRANSFORMS.noisy(makeRegion(prof.tzone, 'tzone', 11 + t * 3 + k)), 'tzone'));
      single.push(Math.abs(shots[0].shine - cleanRef.tzone.shine) + Math.abs(shots[0].poreDen - cleanRef.tzone.poreDen) * 10);
      const agg = E.aggregateBurst(shots);
      burst.push(Math.abs(agg.shine - cleanRef.tzone.shine) + Math.abs(agg.poreDen - cleanRef.tzone.poreDen) * 10);
    }
    const mean = a => a.reduce((x, y) => x + y, 0) / a.length;
    out.burst = { singleMeanDev: +mean(single).toFixed(4), burstMeanDev: +mean(burst).toFixed(4) };
    console.log('[4c] 연사 효과 — 단일 편차', out.burst.singleMeanDev, '→ 3장 중앙값', out.burst.burstMeanDev);
  }
  res.strengthen = out;
}

/* ───────── 5. 재촬영 히스테리시스 — 직전 결과(prev)를 넘겼을 때 타입 뒤집힘 감소 측정 ───────── */
{
  let flipNo = 0, flipPrev = 0, tot = 0;
  for (const [pname, prof] of Object.entries(PROFILES)) {
    const baseImgs = { tzone: makeRegion(prof.tzone, 'tzone', 11), cheek: makeRegion(prof.cheek, 'cheek', 22), nose: makeRegion(prof.nose, 'nose', 33) };
    const photos = Object.fromEntries(Object.entries(TRANSFORMS).map(([tn, tf]) => {
      const rd = {}; for (const rk of ['tzone', 'cheek', 'nose']) rd[rk] = E.analyzeRegionShot(tf(baseImgs[rk]), rk);
      return [tn, E.combineRegions(rd)];
    }));
    const names = Object.keys(TRANSFORMS);
    for (const k of PERSONAS) {
      for (let i = 0; i < names.length; i++) for (let j = 0; j < names.length; j++) { if (i === j) continue;
        const Sv1 = runSurvey(photos[names[i]], k), Sv2 = runSurvey(photos[names[j]], k);
        const r1 = E.fuse(Sv1, photos[names[i]]);
        const r2no = E.fuse(Sv2, photos[names[j]]);
        const r2prev = E.fuse(Sv2, photos[names[j]], { primary: r1.primary, F: r1.F });
        tot++; if (r2no.primary !== r1.primary) flipNo++; if (r2prev.primary !== r1.primary) flipPrev++;
      }
    }
  }
  res.retakeHysteresis = { pairs: tot, flipRateNoPrev: +(flipNo / tot).toFixed(4), flipRateWithPrev: +(flipPrev / tot).toFixed(4) };
  console.log('[5] 재촬영 뒤집힘율 — prev 없이', res.retakeHysteresis.flipRateNoPrev, '→ prev 전달 시', res.retakeHysteresis.flipRateWithPrev, '(' + tot + '쌍)');
}

const file = path.join(OUT_DIR, LABEL + '.json');
fs.writeFileSync(file, JSON.stringify(res, null, 1));
console.log('저장:', file);
