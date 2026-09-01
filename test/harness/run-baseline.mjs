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
    out[pname] = {
      agree, agreeMean: +(agreeSum / PERSONAS.length).toFixed(3),
      SpSpread: { oily: spread(0), dry: spread(1), acne: spread(2) },
      idxSpread: { tzOil: idxSpread('tzOil'), pore: idxSpread('pore'), red: idxSpread('red') },
      variants,
    };
    console.log('[2]', pname.padEnd(8), '일치율', out[pname].agreeMean, '· Sp흔들림', JSON.stringify(out[pname].SpSpread), '· idx흔들림', JSON.stringify(out[pname].idxSpread));
  }
  res.photoConsistency = out;
  const all = Object.values(out);
  res.photoConsistencySummary = {
    agreeMean: +(all.reduce((s, p) => s + p.agreeMean, 0) / all.length).toFixed(3),
    worstProfile: Object.entries(out).sort((a, b) => a[1].agreeMean - b[1].agreeMean)[0][0],
    tzOilIdxSpreadMax: Math.max(...all.map(p => p.idxSpread.tzOil ?? 0)),
  };
  console.log('[2] 전체 평균 일치율', res.photoConsistencySummary.agreeMean, '· 최악 프로필', res.photoConsistencySummary.worstProfile, '·', ((Date.now() - t0) / 1000).toFixed(1) + 's');
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

const file = path.join(OUT_DIR, LABEL + '.json');
fs.writeFileSync(file, JSON.stringify(res, null, 1));
console.log('저장:', file);
