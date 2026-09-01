/* 실측 런로그 → CAL 재보정안 제안 도구
   ------------------------------------------------------------------
   diagnose-bw.html이 진단 1회마다 기기 로컬(localStorage 'bfm_runlog')에 남기는
   측정 로그(숫자만, 사진 없음)를 ?bfmdebug 결과 화면의 [복사]로 내보내
   JSON 파일로 저장한 뒤 이 스크립트에 넘긴다:

     node test/harness/calibrate.mjs 로그1.json [로그2.json ...]
     node test/harness/calibrate.mjs --target-c 0.3 로그.json   # C타입 목표 비율 지정

   출력: 측정 분포(부위별 백분위수) + CAL 제안값 + troubleMin-목표배분 표.
   ⚠️ 제안일 뿐이다 — CAL을 고쳤으면 반드시 `node test/harness/run-baseline.mjs`로
   회귀(일관성·타입 매트릭스)를 확인하고 커밋할 것. */
import fs from 'node:fs';

const args = process.argv.slice(2);
let targetC = null; const files = [];
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--target-c') targetC = parseFloat(args[++i]);
  else files.push(args[i]);
}
if (!files.length) { console.error('사용법: node test/harness/calibrate.mjs <런로그.json> [...]'); process.exit(1); }

const runs = files.flatMap(f => JSON.parse(fs.readFileSync(f, 'utf8')));
console.log(`런로그 ${runs.length}건 (파일 ${files.length}개)\n`);
if (runs.length < 9) console.log('⚠️ 9건 미만 — ROLLOUT 3단계(3조명×3회)만큼도 안 된다. 제안은 참고로만.\n');

const pct = (arr, p) => { if (!arr.length) return null; const s = arr.slice().sort((a, b) => a - b); return s[Math.min(s.length - 1, Math.round(p * (s.length - 1)))]; };
const fmt = x => x == null ? '—' : (+x).toFixed(4);

/* 부위별 측정 분포 */
const FIELDS = ['shine', 'redSpot', 'redFlush', 'poreDen', 'rough', 'q', 'bright'];
for (const rk of ['tzone', 'cheek', 'nose']) {
  const rows = runs.map(r => r.rg && r.rg[rk]).filter(Boolean);
  if (!rows.length) continue;
  console.log(`── ${rk} (${rows.length}건)`);
  for (const f of FIELDS) {
    const v = rows.map(r => r[f]).filter(x => x != null);
    if (v.length) console.log(`  ${f.padEnd(8)} p10 ${fmt(pct(v, .1))} · p50 ${fmt(pct(v, .5))} · p90 ${fmt(pct(v, .9))}`);
  }
}

/* CAL 제안 — 원리: 상한(Full/Span)은 표본 p90이 지수 상단에 오게, 하한(Lo/Offset)은 p40이 0 근처에 오게 */
const tz = runs.map(r => r.rg?.tzone?.shine).filter(x => x != null);
const rs = runs.map(r => r.rg?.cheek?.redSpot).filter(x => x != null);
const pd = runs.map(r => r.rg?.nose?.poreDen).filter(x => x != null);
const rg2 = runs.map(r => Math.max(r.rg?.tzone?.rough ?? 0, r.rg?.cheek?.rough ?? 0)).filter(x => x > 0);
console.log('\n── CAL 제안 (현재값은 engine/bfm-skin-engine.js 참조)');
if (tz.length) { console.log(`  shineFull  ≈ ${fmt(pct(tz, .9))}   (T존 shine p90 — 상위 10%가 유분 만점)`);
  console.log(`  dryZero    ≈ ${fmt(pct(tz, .5))}   (T존 shine p50 — 중앙값 이상이면 건성 신호 소멸)`); }
if (rs.length) { console.log(`  redOffset  ≈ ${fmt(pct(rs, .4))}   (볼 redSpot p40 — 정상 혈색 하한)`);
  console.log(`  redFull    ≈ ${fmt(Math.max(0.02, pct(rs, .9) - pct(rs, .4)))}   (p90−p40)`); }
if (pd.length) { console.log(`  poreDenLo  ≈ ${fmt(pct(pd, .3))} · poreDenSpan ≈ ${fmt(Math.max(0.001, pct(pd, .9) - pct(pd, .3)))}`); }
if (rg2.length) { console.log(`  roughLo    ≈ ${fmt(pct(rg2, .4))} · roughSpan ≈ ${fmt(Math.max(0.05, pct(rg2, .9) - pct(rg2, .4)))}`); }

/* 타입 분포 + troubleMin 민감도 — A/B/C 목표 배분은 사업 결정(대표): F[2] 분포에서 역산 */
const types = runs.map(r => r.type).filter(Boolean);
const share = k => types.filter(t => t === k).length / (types.length || 1);
console.log(`\n── 실측 타입 분포: A건성 ${(share('dry') * 100).toFixed(0)}% · B지성 ${(share('oily') * 100).toFixed(0)}% · C트러블 ${(share('trouble') * 100).toFixed(0)}%`);
const f2 = runs.map(r => r.F && r.F[2]).filter(x => x != null);
if (f2.length) {
  console.log('── troubleMin ↔ C 비율 (이 표본 기준):');
  for (const tm of [0.24, 0.26, 0.28, 0.30, 0.32, 0.34]) {
    const c = f2.filter(x => x >= tm).length / f2.length;
    console.log(`   troubleMin ${tm.toFixed(2)} → C ${(c * 100).toFixed(0)}%${Math.abs(tm - 0.28) < 0.001 ? '  ← 현재' : ''}`);
  }
  if (targetC != null) {
    const s = f2.slice().sort((a, b) => b - a); const idx = Math.max(0, Math.round(targetC * s.length) - 1);
    console.log(`   목표 C=${(targetC * 100).toFixed(0)}% → troubleMin ≈ ${fmt(s[idx])}`);
  }
}
console.log('\n다음: CAL 수정 → node test/harness/run-baseline.mjs <라벨> 로 회귀 확인 → 커밋');
