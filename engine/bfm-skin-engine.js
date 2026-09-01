/* ============================================================================
 * BfM Skin Engine — 피부 진단 엔진 (단일 소스)
 * ----------------------------------------------------------------------------
 * 이 파일이 진단 로직의 유일한 진실이다. 페이지(디자인)는 이 모듈을 import해서
 * 화면만 그리면 된다. 브라우저(ES module)와 Node(테스트 하니스) 양쪽에서 돈다.
 *
 * 사용 흐름 (자세한 예시는 engine/README.md):
 *   1) 부위 사진 3장(캔버스) → analyzeRegionShot(canvas, 'tzone'|'cheek'|'nose')
 *   2) combineRegions({tzone, cheek, nose})  → photo 결과(Sp·q·idx)
 *   3) buildSurveyQuestions(photo)           → 설문 문항 배열
 *   4) scoreSurvey(Q, answers)               → 설문 벡터 Sv
 *   5) fuse(Sv, photo)                       → 최종 판정 {primary, typeKey, F, band, flags}
 *   6) reasonText(r, photo)                  → 결과 근거 문구(HTML)
 * 라이브 카메라 코칭은 assessRegionFrame() 참조.
 *
 * ⚠️ 판정 상수(CAL)·게이트 상수(VF)를 바꿀 땐 반드시 test/harness 스윕을 돌려
 *    A/B/C 분포·일관성 지표를 확인할 것: `node test/harness/run-baseline.mjs`
 * ========================================================================== */

/* ===== 기본 유틸 ===== */
export const clamp = (x, a, b) => Math.max(a, Math.min(b, x));
export const normalize = v => { const s = v.reduce((a, b) => a + Math.max(0, b), 0) || 1; return v.map(x => Math.max(0, x) / s); };
export const argmax = v => { let m = 0; for (let i = 1; i < v.length; i++) if (v[i] > v[m]) m = i; return m; };

/* ===== 타입 매핑 ===== */
export const TYPES = ['지성', '건성', '여드름'];
export const TYPE_KEY = { 지성: 'oily', 건성: 'dry', 여드름: 'trouble' };
export const PERSONAS = {
  지성: { name: '타입 B', en: '지성', tag: '유분·번들거림을 단정하게 다스리는 타입' },
  건성: { name: '타입 A', en: '건성', tag: '수분 부족한 피부를 매끈하게 채우는 타입' },
  여드름: { name: '타입 C', en: '복합', tag: '유분과 자극을 함께 다스리는 타입' },
};

/* ===== 캔버스 팩토리 (Node 테스트에서 주입) ===== */
let createCanvas = (typeof document !== 'undefined') ? () => document.createElement('canvas') : null;
export function configure(opts = {}) { if (opts.createCanvas) createCanvas = opts.createCanvas; }

/* ===== 판정 상수 — 값 바꿀 땐 근거를 주석으로 남길 것 ===== */
export const CAL = {
  troubleMin: 0.28, // 트러블 합성점수가 이 값 이상이면 타입 C(트러블) 유지 — 초기 0.34에서 하향('여드름 있는 지성' 응답이 경계에서 B로 쏠려서). A/B/C 목표 배분에 따라 대표가 조정
  shineFull: 0.11,  // 유분: 광택 픽셀 비율이 이 값이면 지수 최대 — 근거 없음, 손으로 맞춘 값(실기기 재보정 예정)
  dryZero: 0.09,    // 건성: 광택이 이 값 이상이면 건성 신호 0 — shineFull과 대칭에 가깝게(근거 동일)
  redOffset: 0.02,  // 붉은기 하한(이 이하는 정상 혈색으로 봄) — 근거 없음, 손으로 맞춘 값
  redFull: 0.13,    // 붉은기: (redness-redOffset)/redFull 로 정규화 — 근거 없음, 손으로 맞춘 값
  poreLo: 70,       // (구) 모공 라플라시안 하한 — poreDen 없을 때 폴백용으로만 유지
  poreHi: 620,      // (구) 모공 정규화 분모 — 폴백용
  poreDenLo: 0.0008, // 모공 국소최소점 밀도 하한 — 링 대비(반경4px)+노이즈 적응 문턱 척도로 2026-09 재보정(합성 스윕 기준, 실기기 9회 측정으로 재확인 예정)
  poreDenSpan: 0.006,// 모공 밀도 정규화 폭 — 위와 동일 근거
  relOilW: 0.55,    // 유분 판정에서 '부위 간 상대신호(T존-볼)' 가중 — 같은 사진 안 비교라 조명이 소거됨
};

/* ===== 촬영 게이트 상수 (★팀 캘리브레이션 — 여기 숫자만 조정) ===== */
export const VF = {
  brDark: 44, brDim: 50, brHot: 232, clipLive: 0.16, clipHot: 0.18, unevenLR: 48, // 조명(완화 — 인식 덜 민감하게)
  skinFar: 0.12,        // 근접 강요 완화(2026-07) — 보통 거리에서도 통과, 벽·빈화면만 거름
  faceSkinMin: 0.06,    // 얼굴피부(색도)비율(완화 — 벽만 걸러낼 정도)
  lapBlur: 18,          // 초점(완화 — 웬만하면 통과)
  motionMax: 20,        // 흔들림(완화)
  symBlock: 0.06, symCoach: 0.30, // 좌우대칭(거의 차단 안 함 — 코 인식 위해)
  readyFrames: 2        // 더 빨리 촬영 허용
};

/* ===== 픽셀 헬퍼 ===== */
export function brightnessOf(d) { let s = 0; for (let i = 0; i < d.length; i += 4) s += 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2]; return s / (d.length / 4); }
export function toGray(d, w, h) { const g = new Float32Array(w * h); for (let i = 0, j = 0; i < d.length; i += 4, j++) g[j] = 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2]; return g; }
export function laplacianVar(g, w, h) { let s = 0, s2 = 0, n = 0; for (let y = 1; y < h - 1; y++) for (let x = 1; x < w - 1; x++) { const i = y * w + x; const l = 4 * g[i] - g[i - 1] - g[i + 1] - g[i - w] - g[i + w]; s += l; s2 += l * l; n++; } const m = s / n; return s2 / n - m * m; }
export function isSkin(r, g, b) { const mx = Math.max(r, g, b), mn = Math.min(r, g, b); return r > 60 && g > 40 && b > 20 && r >= g && r >= b && (r - g) >= 8 && (mx - mn) >= 12; }
/* 얼굴 피부 색도 판정 — 정규화 rg-chromaticity. 피부톤 넓게 허용, 회색·무채색·엉뚱한 색 거름 */
export function isFaceSkin(r, g, b) { const s = r + g + b; if (s < 95) return false; const nr = r / s, ng = g / s, nb = b / s;
  return nr > 0.345 && nr < 0.475 && ng > 0.275 && ng < 0.350 && nr >= ng && (nr - nb) > 0.015; }
/* 좌우 구조 대칭도 0~1 (그래디언트 기반 → 조명 치우침에 강함). T존·코는 얼굴 중심선이라 대칭이어야 함 */
export function structSymmetry(g, w, h) { let sMin = 0, sMax = 0; const hw = w >> 1;
  for (let y = 1; y < h - 1; y++) for (let x = 1; x < hw; x++) { const i = y * w + x, mi = y * w + (w - 1 - x);
    const m = Math.abs(g[i + 1] - g[i - 1]) + Math.abs(g[i + w] - g[i - w]);
    const mm = Math.abs(g[mi + 1] - g[mi - 1]) + Math.abs(g[mi + w] - g[mi - w]);
    sMin += Math.min(m, mm); sMax += Math.max(m, mm); }
  return sMax ? sMin / sMax : 1; }

/* ===== 표시용 지수 ===== */
export const P100 = x => Math.round(clamp(x, 0, 1) * 100);
/* 표시용 지수: √커브(저신호 증폭)+최소 10 — 웬만해선 0 안 나오게 */
export const PIDX = x => x == null ? null : Math.round(10 + 86 * Math.sqrt(clamp(x, 0, 1)));

/* ===== 부위 원시 측정 (룰베이스 지수) =====
 * c: 부위 사진 캔버스(중앙 68%가 ROI), region: 'tzone'|'cheek'|'nose'
 * 반환: {shine, redness, lap, bright, skinRatio, faceSkinRatio, sym, q, reason, poreDen, clipR} */
export function analyzeRegionShot(c, region) { const ctx = c.getContext('2d', { willReadFrequently: true });
  const w = c.width, h = c.height, rx = (w * 0.16) | 0, ry = (h * 0.16) | 0, rw = (w * 0.68) | 0, rh = (h * 0.68) | 0;
  /* 게이트용(원본 해상도 유지 — lapBlur 등 기존 임계값과 호환) */
  const d = ctx.getImageData(rx, ry, rw, rh); const dd = d.data; const bright = brightnessOf(dd);
  const gray = toGray(dd, rw, rh), lap = laplacianVar(gray, rw, rh);
  const sym = (region === 'tzone' || region === 'nose') ? structSymmetry(gray, rw, rh) : 1;
  /* ── 측정용: 분석 해상도 640 고정 — 카메라(1080)와 업로드(720)가 같은 척도를 갖게 ── */
  const AW = 640, AH = Math.max(2, Math.round(rh * AW / rw));
  const ac = analyzeRegionShot._ac || (analyzeRegionShot._ac = createCanvas());
  ac.width = AW; ac.height = AH; const actx = ac.getContext('2d', { willReadFrequently: true });
  actx.imageSmoothingQuality = 'high'; actx.drawImage(c, rx, ry, rw, rh, 0, 0, AW, AH);
  const ad = actx.getImageData(0, 0, AW, AH).data;
  /* 1차: 피부 마스크(색도 기반 isFaceSkin — 조명에 강함) + 평균 휘도 */
  let tot = 0, fskin = 0, skinLoose = 0, sumLum = 0; const mask = new Uint8Array(AW * AH);
  for (let p = 0; p < AW * AH; p++) { const i = p * 4; tot++; const R = ad[i], G = ad[i + 1], B = ad[i + 2];
    if (isSkin(R, G, B)) skinLoose++;
    if (isFaceSkin(R, G, B)) { fskin++; mask[p] = 1; sumLum += 0.299 * R + 0.587 * G + 0.114 * B; } }
  const useLoose = fskin < 500; /* 초근접 등으로 색도 마스크가 빈약하면 느슨한 마스크로 폴백 */
  if (useLoose) { sumLum = 0; let n = 0; for (let p = 0; p < AW * AH; p++) { const i = p * 4; const R = ad[i], G = ad[i + 1], B = ad[i + 2]; mask[p] = isSkin(R, G, B) ? 1 : 0; if (mask[p]) { sumLum += 0.299 * R + 0.587 * G + 0.114 * B; n++ } } fskin = n; }
  const meanSkinLum = fskin ? sumLum / fskin : bright;
  const gain = clamp(165 / (meanSkinLum || 1), 0.75, 1.35); /* 휘도 게인 — 회색세계 가정 대신 피부 평균 밝기 기준 */
  /* 2차: 광택 = 스페큘러(정반사) 픽셀 — "평균 피부보다 확 밝고(V>meanV×1.12) 색이 빠진(S<0.26)" 픽셀 비율.
     예전 분위수 문턱(p60+0.55·(p97−p60))은 완전 무광 피부도 분포 모양 때문에 shine≈0.12가 나와
     shineFull(0.11)을 넘겨버렸고(건성→유분 오판), 실제 광택이 늘면 문턱이 같이 올라 값이 내려가는
     비단조성도 있었다(2026-09 합성 스윕으로 확인). 채도 조건은 곱셈성 조명 변화에 불변이라
     노출·조명기울기에도 강함. 정반사는 광원색(≈무채색)이 섞여 채도가 빠진다는 물리 근거. */
  let shine = 0, clipR = 0, sk = 0;
  { let s = 0, cl = 0, sumV = 0;
    for (let p = 0; p < AW * AH; p++) { if (!mask[p]) continue; const i = p * 4; sk++;
      const R = Math.min(255, ad[i] * gain), G = Math.min(255, ad[i + 1] * gain), B = Math.min(255, ad[i + 2] * gain);
      sumV += Math.max(R, G, B) / 255; }
    /* 16px 블록별 피부 밀도 — 강한 하이라이트는 색이 빠져 피부색 마스크에서 탈락하므로(흰색≠피부색),
       "피부가 충분히 있는 블록 위의 무채색 하이라이트"만 광택으로 재인정한다. 멀리 있는 흰 벽·조명 제외. */
    const BS = 16, BW = Math.ceil(AW / BS), BH2 = Math.ceil(AH / BS); const bcnt = new Float32Array(BW * BH2);
    for (let p = 0; p < AW * AH; p++) if (mask[p]) bcnt[((p / AW | 0) / BS | 0) * BW + ((p % AW) / BS | 0)]++;
    const skinBlock = p => bcnt[((p / AW | 0) / BS | 0) * BW + ((p % AW) / BS | 0)] > BS * BS * 0.20;
    if (sk) { const meanV = sumV / sk; const vthr = clamp(meanV * 1.12, 0.55, 0.95);
      for (let p = 0; p < AW * AH; p++) { const i = p * 4;
        const rawMx = Math.max(ad[i], ad[i + 1], ad[i + 2]), rawMn = Math.min(ad[i], ad[i + 1], ad[i + 2]);
        const S = rawMx ? (rawMx - rawMn) / rawMx : 0; const V = Math.min(255, rawMx * gain) / 255;
        let spec = false;
        if (mask[p]) { if ((V > vthr && S < 0.26) || (rawMx >= 252 && S < 0.20)) spec = true; if (V >= 0.985) cl++; }
        /* rawMx≥252: 과노출로 클리핑된 스페큘러 — 피부가 밝아지면 상대 문턱(meanV×1.12)에 헤드룸이
           없어져 광택이 0으로 붕괴하던 문제(합성 bright20에서 확인) 보정 */
        else if (S < 0.20 && (rawMx >= 252 || (V > Math.max(vthr, 0.70) && S < 0.18)) && skinBlock(p)) spec = true;
        if (spec) s++; }
      shine = Math.min(s / sk, 0.5); clipR = cl / sk; } }
  /* 붉은기 = rg-색도 오프셋 — 느슨한 피부 마스크(isSkin) 위에서 nr=R/(R+G+B)가
     중앙값보다 +0.03 이상 높은 픽셀 비율. 예전 r/g 중앙값×1.18 방식은 ① 진하게 붉은 픽셀이
     색도 마스크(isFaceSkin nr<0.475)에서 탈락해 블로치의 가장자리만 재고 ② 감마 변화에
     0.05→0.001로 붕괴했다(2026-09 합성 스윕). 색도는 노출(곱셈) 불변, 오프셋 기준이라
     "전부 균일하게 붉은" 얼굴에서도 0으로 수렴하는 성질은 유지(블로치 탐지 목적). */
  let red = 0, redN = 0;
  { const nrs = [];
    for (let p = 0; p < AW * AH; p++) { const i = p * 4; const R = ad[i], G = ad[i + 1], B = ad[i + 2];
      if (!isSkin(R, G, B)) continue; nrs.push(R / ((R + G + B) || 1)); }
    redN = nrs.length;
    if (redN) { const srt = nrs.slice().sort((a, b) => a - b); const med = srt[(srt.length / 2) | 0];
      for (const nr of nrs) if (nr > med + 0.030) red++; } }
  /* 모공: 국소최소점 밀도 — 자기 휘도를 "반경 4px 링의 평균"과 비교.
     예전 5×5 창 평균은 모공 크기(2~3px)와 창 크기가 비슷해 창 평균이 모공 자체가 되어
     대비가 늘 0에 수렴했다(합성 모공에서 poreDen=0 확인). 링 비교는 모공 밖 피부와 비교. */
  const ag = toGray(ad, AW, AH); let pits = 0, pitN = 0; const RR = 4;
  /* 노이즈 적응 문턱 — 고감도(어두운 곳) 사진에서 센서 노이즈가 모공으로 잡히던 것 억제:
     이웃 픽셀 차의 평균(≈노이즈 크기)만큼 문턱을 올린다 */
  let madSum = 0, madN = 0;
  for (let p = RR * AW; p < AW * (AH - RR); p += 2) { if (!mask[p]) continue; madSum += Math.abs(ag[p] - ag[p + 1]); madN++; }
  const nthr = 12 + 1.5 * (madN ? madSum / madN : 0); /* 12/gain 비례 문턱도 시도했으나 저조도에서 노이즈 오탐이 늘어 되돌림(after-fix5 스윕) */
  for (let py = RR; py < AH - RR; py += 2) for (let px = RR; px < AW - RR; px += 2) { const p = py * AW + px; if (!mask[p]) continue; pitN++;
    const ring = (ag[p - RR * AW] + ag[p + RR * AW] + ag[p - RR] + ag[p + RR]
      + ag[p - 3 * AW - 3] + ag[p - 3 * AW + 3] + ag[p + 3 * AW - 3] + ag[p + 3 * AW + 3]) / 8;
    if (ring - ag[p] > nthr) pits++; }
  const poreDen = pitN ? pits / pitN : 0;
  const skinRatio = skinLoose / (tot || 1), faceSkinRatio = fskin / (tot || 1);
  const light = clamp((bright - 45) / 30, 0, 1) * clamp((225 - bright) / 30, 0, 1);
  const glareOk = clamp((0.15 - clipR) / 0.15, 0.3, 1); /* 클리핑 많으면 신뢰 하락 */
  const q = (0.30 * light + 0.28 * clamp((lap - 25) / 120, 0, 1) + 0.24 * clamp((skinRatio - 0.20) / 0.30, 0, 1) + 0.18 * clamp((faceSkinRatio - 0.15) / 0.30, 0, 1)) * glareOk;
  let reason = null; // 정지영상 하드 차단(재촬영) 사유
  if (bright < VF.brDark) reason = 'dark'; else if (bright > VF.brHot) reason = 'bright';
  else if (faceSkinRatio < VF.faceSkinMin && skinRatio < 0.5) reason = 'noskin';
  else if (skinRatio < VF.skinFar) reason = 'far'; else if (lap < VF.lapBlur) reason = 'blur';
  else if (sym < VF.symBlock && (region === 'tzone' || region === 'nose')) reason = 'offcenter';
  return { shine, redness: redN ? red / redN : 0, lap, bright, skinRatio, faceSkinRatio, sym, q, reason, poreDen, clipR }; }

/* ===== 부위 종합 =====
 * regionData: {tzone?, cheek?, nose?} — 각각 analyzeRegionShot 결과(+faceSeen 선택)
 * 반환: photo 결과 {ok, regions, q, Sp, shine, shineDiff, redness, idx} — 부위가 하나도 없으면 null */
export function combineRegions(regionData) { const tz = regionData.tzone, n = regionData.nose, ch = regionData.cheek; if (!tz && !n && !ch) return null;
  const tzOilC = tz ? clamp(tz.shine / CAL.shineFull, 0, 1) : null, noseOil = n ? clamp(n.shine / CAL.shineFull, 0, 1) : null;
  const pore = n ? (n.poreDen != null ? clamp((n.poreDen - CAL.poreDenLo) / CAL.poreDenSpan, 0, 1) : clamp((n.lap - CAL.poreLo) / CAL.poreHi, 0, 1)) : null; /* 국소최소점 밀도 우선, 구버전 데이터만 lap 폴백 */
  const cheekOil = ch ? clamp(ch.shine / CAL.shineFull, 0, 1) : null, cheekRed = ch ? clamp((ch.redness - CAL.redOffset) / CAL.redFull, 0, 1) : null;
  let oilSig = tzOilC ?? noseOil ?? 0.3;
  /* 상대 측정: T존 vs 볼은 같은 조명을 받으므로 둘의 차이는 촬영 조건에 거의 불변 — 절대값보다 신뢰도 높음 */
  if (tz && ch) { const rel = clamp((tz.shine - ch.shine) / 0.05, 0, 1); oilSig = CAL.relOilW * rel + (1 - CAL.relOilW) * oilSig; }
  const oily = clamp(0.45 * oilSig + 0.30 * (noseOil ?? oilSig) + 0.10 * (pore ?? oilSig) + 0.15 * oilSig, 0, 1); /* 모공 가중 0.25→0.10 (모공은 유분의 간접 신호일 뿐) */
  const shineTz = tz ? tz.shine : (n ? n.shine : 0);
  const dryBase = clamp((CAL.dryZero - shineTz) / CAL.dryZero, 0, 1); /* 0.05 절벽 완화 — shine 0.05만 넘으면 건성 신호가 0이 되던 문제, oily 정규화와 대칭에 가깝게 */
  const dry = clamp(0.55 * dryBase + 0.45 * (cheekOil != null ? clamp((1 - cheekOil) * dryBase * 1.6, 0, 1) : dryBase), 0, 1);
  const acne = clamp(cheekRed ?? (n ? clamp((n.redness - CAL.redOffset) / CAL.redFull, 0, 1) : 0), 0, 1); /* 볼 없을 때 코 폴백도 같은 상수 사용(예전엔 0.05/0.12로 세대가 달랐음) */
  const parts = [tz, n, ch].filter(Boolean); const rq = parts.reduce((s, p) => s + p.q, 0) / (parts.length || 1);
  const anyFace = parts.some(p => p.faceSeen); // 촬영 중 얼굴 감지된 부위 있으면 실사람 확인 → 신뢰↑
  const q = clamp(rq * (0.55 + 0.45 * parts.length / 3) * (anyFace ? 1.08 : 1), 0, 1); // 찍은 부위 많을수록·얼굴 잡힐수록 신뢰↑
  const shineDiff = (tz && ch) ? Math.max(0, tz.shine - ch.shine) : (oily > 0.5 ? 0.08 : 0); // T존 vs 볼 = 복합성 판단
  return { ok: true, regions: true, q, Sp: normalize([oily + 0.12, dry + 0.12, acne + 0.12]), shine: shineTz, shineDiff, /* 세 축 동일 가산 — argmax 보존, [1,0,0] 포화·oily 단독 특혜 제거 */
    redness: ch ? ch.redness : (n ? n.redness : 0),
    idx: { tzOil: PIDX(tzOilC), noseOil: PIDX(noseOil), pore: PIDX(pore), cheekOil: PIDX(cheekOil), red: PIDX(cheekRed) } }; }

/* ===== 설문 ===== */
export const CORE = [
  { sec: '유분·수분', q: '세수하고 30분 뒤, 아무것도 안 바른 얼굴은?', o: ['이마·코가 번들거린다|o3', 'T존만 번들, 볼은 당긴다|o2d1', '전체적으로 당기고 건조하다|d3', '잘 모르겠다|'] },
  { sec: '유분·수분', q: '점심쯤 이마·코 상태는?', o: ['번들거려 닦아낸다|o2', '약간 번들거린다|o1', '보송하다|', '오히려 당긴다|d2'] },
  { sec: '유분·수분', q: '모공이 눈에 띄는 편인가요?', o: ['넓고 많이 보인다|o2', '보통이다|', '거의 안 보인다|d1'] },
  { sec: '유분·수분', q: '피부가 자주 당기거나 각질이 일어나나요?', o: ['자주 그렇다|d3', '가끔 그렇다|d1', '거의 없다|'] },
  { sec: '유분·수분', q: '보습제를 바른 뒤 느낌은?', o: ['금세 번들거린다|o2', '적당히 촉촉하다|', '발라도 당긴다|d2'] },
  { sec: '트러블', q: '여드름·뾰루지 같은 트러블이 얼마나 있나요?', o: ['자주, 여러 개 난다|a5', '가끔 한두 개|a2', '거의 없다|'] }, /* 직접 질문 배점 강화 — 유분 문항 5개에 파묻혀 '여드름 있는 지성'이 늘 B로 가던 문제 */
];
export const FOCUS = {
  oily: [{ sec: '유분', q: '시간이 지나면 화장·선크림이 잘 무너지나요?', o: ['자주 무너진다|o2', '가끔|o1', '잘 안 무너진다|'] }, { sec: '유분', q: '오후나 여름에 유분이 특히 심해지나요?', o: ['매우 심하다|o2', '약간|o1', '비슷하다|'] }],
  dry: [{ sec: '건성', q: '각질이 일어나거나 가루처럼 보일 때가 있나요?', o: ['자주 있다|d2', '가끔|d1', '거의 없다|'] }, { sec: '건성', q: '실내·겨울 등 건조한 곳에서 더 당기나요?', o: ['많이 당긴다|d2', '조금|d1', '별 차이 없다|'] }],
  acne: [{ sec: '트러블', q: '면도 후 붉어지거나 따가운가요?', o: ['자주 그렇다|a2', '가끔|a1', '괜찮다|'] }, { sec: '트러블', q: '같은 부위에 트러블이 반복되나요?', o: ['자주 반복된다|a2', '가끔|a1', '거의 없다|'] }],
  def: [{ sec: '트러블', q: '얼굴에 붉은기나 자극을 자주 느끼나요?', o: ['자주|a2', '가끔|a1', '거의 없다|'] }, { sec: '마무리', q: '가장 신경 쓰이는 점은?', o: ['번들거림·모공|o2', '당김·각질|d2', '트러블·붉은기|a2', '딱히 없다|'] }],
};
export function parseOpt(s) { const [t, code] = s.split('|'); const m = { o: 0, d: 0, a: 0 }; (code || '').replace(/([oda])(\d)/g, (_, k, n) => { m[k] = +n; }); return { t, ...m }; }
export function dominantHint(f) { if (!f || !f.ok || f.q < 0.4) return null; return ['oily', 'dry', 'acne'][argmax(f.Sp)]; }
/* photo 결과 → 설문 문항 배열. 사진 힌트로 FOCUS 세트를 고르고, 유분/건성 힌트여도 트러블 통로 1문항 확보 */
export function buildSurveyQuestions(photo) {
  const hint = dominantHint(photo); let focus = FOCUS[hint] || FOCUS.def;
  if (hint === 'oily' || hint === 'dry') focus = [...focus, FOCUS.acne[1]];
  return [...CORE, ...focus].map(x => ({ sec: x.sec, q: x.q, opts: x.o.map(parseOpt) }));
}
/* 설문 점수 → 벡터. ans[i] = Q[i].opts 인덱스(-1 = 무응답) */
export function scoreSurvey(Q, ans) { let o = 0, d = 0, a = 0; Q.forEach((q, i) => { const opt = q.opts[ans[i]] || {}; o += opt.o || 0; d += opt.d || 0; a += opt.a || 0; }); o += 1.5; d += 1.4; a += 1.0; return normalize([o, d, a]); } /* 세 축 공통 바닥값(동점 방지용 미세 차등) — 예전 o+=2는 유분만 가산해 지성 쏠림 */

/* ===== 융합 판정 ===== */
export function fuse(Sv, photo) {
  /* 사진 가중을 q=0.35~0.65 구간에서 매끄럽게 올림 — 예전 "q≥0.5면 켜고 아니면 끔" 하드컷은
     경계 근처에서 조명 미세 변화만으로 사진 반영이 0↔0.45로 뒤집혀 재촬영 시 결과가 튀던 원인 */
  const qRamp = photo && photo.ok ? clamp((photo.q - 0.35) / 0.30, 0, 1) : 0;
  const usedPhoto = qRamp > 0; const w_p = usedPhoto ? (photo.regions ? 0.45 : 0.30) * clamp(photo.q, 0, 1) * qRamp : 0; const w_v = 1 - w_p; const Sp = usedPhoto ? photo.Sp : [0, 0, 0];
  const F = [0, 1, 2].map(i => w_v * Sv[i] + w_p * Sp[i]); let primary = argmax(F); const flags = [];
  /* 트러블 우선 규칙 — C 처방은 '유분과 자극을 함께' 커버하므로, 트러블 신호가 임계 이상이면
     유분이 1위여도 C로 보낸다. (여드름 피부는 번들거림도 같이 답해 유분이 산술적으로 늘 이기던 문제) */
  if (F[2] >= CAL.troubleMin) primary = 2;
  else if (F[2] > 0.24 || (usedPhoto && photo.Sp[2] > 0.45)) flags.push('여드름 주의');
  if (usedPhoto && photo.shine != null && photo.shine < 0.05 && primary === 0 && Sv[1] > 0.25) flags.push('부분 건성');
  const sorted = [...F].sort((a, b) => b - a); const margin = sorted[0] - sorted[1]; const agree = !usedPhoto ? 0.6 : (argmax(Sv) === argmax(photo.Sp) ? 1 : 0.4);
  const conf = (usedPhoto ? clamp(photo.q, 0, 1) : 0.55) * 0.4 + clamp(margin / 0.3, 0, 1) * 0.35 + agree * 0.25;
  return { F, primary, typeKey: TYPE_KEY[TYPES[primary]], flags, band: conf > 0.7 ? '높은 확신' : conf > 0.45 ? '보통 확신' : '낮은 확신', usedPhoto };
}

/* ===== 결과 근거 문구 (HTML) ===== */
export function reasonText(r, photo) { let s = '';
  if (r.usedPhoto) { s += photo.regions ? 'T존·볼·코 부위 사진과 설문을 함께 분석했어요. ' : '셀카와 설문을 함께 분석했어요. ';
    if (photo.shineDiff > 0.06) s += '<b>T존 광택이 높아</b> 유분이 많은 편이고, '; else if (photo.shine < 0.05) s += '광택이 적어 유분은 낮은 편이고, ';
    if (photo.redness > 0.06) s += '볼에 약한 붉은기가 보여 <b>진정 케어</b>도 함께 고려했어요. ';
    if (photo.regions && photo.idx) { const i = photo.idx; s += `부위 지수 — T존 유분 <b>${i.tzOil}</b>${i.pore != null ? ` · 코 모공 <b>${i.pore}</b>` : ''}${i.red != null ? ` · 볼 붉은기 <b>${i.red}</b>` : ''}. `; }
    s += '이 신호에 가장 맞는 처방을 매칭했습니다.'; }
  else s += '설문 답변을 분석해, 당신에게 <b>가장 맞는 처방</b>을 매칭했어요.'; return s; }

/* ===== 라이브 카메라 프레임 코칭 =====
 * 페이지가 프레임마다 100×128 중앙 크롭 ImageData와 컨텍스트를 넘기면
 * {reason(차단 사유 or null), softNudge, stats}를 돌려준다. 촬영 버튼 활성화는
 * 페이지에서 okRun >= VF.readyFrames 로 판단.
 * ctx: {region:'tzone'|'cheek'|'nose', motion:number, face:{active,posBad,far,good}} */
export function assessRegionFrame(d, w, h, ctx) {
  let brL = 0, brR = 0, nL = 0, nR = 0, clip = 0, tot = 0, skin = 0, fskin = 0;
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) { const i = (y * w + x) * 4; const R = d[i], G = d[i + 1], B = d[i + 2]; const lum = 0.299 * R + 0.587 * G + 0.114 * B; tot++; if (lum > 247) clip++; const mxp = Math.max(R, G, B), mnp = Math.min(R, G, B); if (isSkin(R, G, B) && (mxp - mnp) / (mxp || 1) >= 0.13) skin++; /* 채도 하한 — 따뜻한 벽지·천장이 피부로 잡히던 오탐 차단 */ if (isFaceSkin(R, G, B)) fskin++; if (x < w / 2) { brL += lum; nL++; } else { brR += lum; nR++; } }
  brL /= nL || 1; brR /= nR || 1; const br = (brL + brR) / 2, clipR = clip / (tot || 1), skinR = skin / (tot || 1), fskinR = fskin / (tot || 1);
  const gray = toGray(d, w, h), lap = laplacianVar(gray, w, h);
  const sym = (ctx.region === 'tzone' || ctx.region === 'nose') ? structSymmetry(gray, w, h) : 1;
  const face = ctx.face || {};
  let reason = null;
  if (br < VF.brDark) reason = '너무 어두워요 — 밝은 곳으로';
  else if (br < VF.brDim) reason = '조금 어두워요 — 빛을 더 받게';
  else if (clipR > VF.clipLive || br > VF.brHot) reason = '빛이 너무 세요 — 창·조명 정면을 피해요';
  else if (Math.abs(brL - brR) > VF.unevenLR) reason = '빛이 한쪽에 치우쳤어요 — 정면에서 받게';
  else if (face.posBad) reason = '얼굴이 화면 구석에 있어요 — 점선 가이드 중앙에 오게';
  else if (face.far) reason = '더 가까이 — 부위가 화면에 크게 오게';
  else if (fskinR < VF.faceSkinMin && skinR < 0.30 && !face.good) reason = '피부가 화면에 꽉 차게 — 얼굴을 더 가까이';
  else if (skinR < VF.skinFar) reason = '더 가까이 — 피부만 화면에 차게';
  else if (lap < VF.lapBlur) reason = '초점이 안 맞아요 — 살짝 멀리';
  else if (ctx.motion > VF.motionMax) reason = '잠깐 멈춰요 — 흔들리고 있어요';
  else if (sym < VF.symBlock && !face.good) reason = (ctx.region === 'nose' ? '코를' : '콧대를') + ' 세로 가운데 점선에 맞춰요';
  const softNudge = (!reason && sym < VF.symCoach && !face.good) ? ((ctx.region === 'nose' ? '코가' : '콧대가') + ' 살짝 치우쳤어요 — 가운데면 더 좋아요') : null;
  return { reason, softNudge, stats: { br, brL, brR, clipR, skinR, fskinR, lap, sym } };
}

/* 엔진 버전 — 판정 로직이 바뀌면 올릴 것 (결과 재현·데이터 수집 시 함께 기록) */
export const ENGINE_VERSION = '2.0.0';
