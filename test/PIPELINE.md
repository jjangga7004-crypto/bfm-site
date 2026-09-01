# BfM 진단 파이프라인 문서 (2026-09-01, batch8-accuracy 브랜치)

> **구조가 바뀌었다(2026-09-01)**: 진단 로직의 단일 소스는 이제 `engine/bfm-skin-engine.js`.
> `diagnose-bw.html`은 이 엔진을 import하는 레퍼런스 화면(레거시 face 모드 삭제됨).
> ⚠️ `diagnose.html`(라이브 PR 대기열)에는 **아직 옛 엔진이 인라인**으로 남아 있음 — 롤아웃 결정 필요(NEXT.md).
> 아래 문서는 엔진 기준. 측정식이 세션 중 수정된 곳은 (★2026-09 수정) 표기 — 근거는 FINDINGS.md.

## 전체 흐름

```
인트로 → [카메라 or 파일업로드]
  → 부위 촬영 3회 (T존 → 볼 → 코, 각각 건너뛰기 가능)
      라이브 게이트: loopRegion() — 밝기/클리핑/좌우균형/얼굴위치/피부비율/초점/모션/대칭
      촬영 → captureStill() → storeRegion() → analyzeRegionShot()  [부위별 원시 측정]
      하드 차단(noskin·dark)이면 goRegionRetake() — 나머지는 통과
  → applyRegions()  [3부위 측정 → oily/dry/acne 벡터 + 부위지수 idx + 품질 q]
  → regionTheater() [연출 — 실측값 기반, 판정에는 무관]
  → 설문 8문항 (CORE 6 + 사진 힌트 기반 FOCUS 2~3)
  → surveyVector() [설문 → oily/dry/acne 벡터]
  → fuse(Sv, faceResult) [가중 융합 → F벡터, primary 타입, 확신 밴드, 플래그]
  → renderResult() → result-bw.html?type=&o=&d=&t=&lc=
```

## 단계별 상세

### 1. 입력
- 카메라: getUserMedia 1080×1440 ideal, 셀피(전면). 촬영 시 W=min(1080, videoWidth)로 캡처.
- 업로드: createImageBitmap, W=min(720, naturalWidth)로 축소. **카메라(1080)와 업로드(720) 해상도가 다름** → analyzeRegionShot에서 분석용 640 고정 캔버스로 재정규화(배치7에서 해결).

### 2. 라이브 촬영 게이트 — loopRegion() + VF 상수
140×180 다운샘플 중앙 100×128 창에서 매 프레임:

| 검사 | 상수 | 값 | 동작 |
|---|---|---|---|
| 너무 어두움 | VF.brDark | 44 | 차단 |
| 조금 어두움 | VF.brDim | 50 | 차단 |
| 과노출 | VF.clipLive / VF.brHot | 0.16 / 232 | 차단 |
| 좌우 조명 편차 | VF.unevenLR | 48 | 차단 |
| 얼굴 위치(검출 시) | cx 0.22~0.78, cy 0.15~0.85 | 하드코딩 | 차단 |
| 얼굴 크기(검출 시) | frac < 0.03 | 하드코딩 | 차단 |
| 얼굴피부 색도 비율 | VF.faceSkinMin | 0.06 | 차단(느슨) |
| 피부 비율 | VF.skinFar | 0.12 | 차단 |
| 초점 | VF.lapBlur | 18 | 차단 |
| 모션 | VF.motionMax | 20 | 차단 |
| 좌우 대칭(T존·코) | VF.symBlock / symCoach | 0.06 / 0.30 | 차단 / 코칭 |
| 연속 통과 프레임 | VF.readyFrames | 2 | 촬영 버튼 활성 |

- 얼굴 검출(BlazeFace)은 5프레임마다 기회주의적 — 잡히면 위치·크기 검사, 못 잡아도 휴리스틱으로 진행.
- **업로드 경로는 라이브 게이트 없음** — analyzeRegionShot의 정지영상 reason(dark/bright/noskin/far/blur/offcenter)만 적용, 그중 **noskin·dark만 재촬영 유도**, 나머지는 "그대로 진행" 허용.

### 3. 부위 원시 측정 — analyzeRegionShot(c, region)
중앙 68% ROI. 게이트용 지표(원본 해상도): bright, lap(라플라시안 분산), sym.
측정용은 **640px 고정 캔버스**로 리샘플 후:

| 산출 | 방법 | 관련 상수 |
|---|---|---|
| 피부 마스크 | isFaceSkin(rg-chromaticity), 500px 미만이면 isSkin 폴백 | 하드코딩 경계값 |
| 휘도 게인 | gain = clamp(165/평균피부휘도, 0.75, 1.35) | 165 하드코딩 |
| shine(광택) | (★2026-09 수정) 스페큘러 측정 — V>meanV×1.12 & 채도<0.26 비율. 마스크 탈락 하이라이트·클리핑(≥252)은 피부 블록 위에서 재인정 | 1.12/0.26/0.18/252/블록16px |
| clipR | V≥0.985 비율 | 하드코딩 |
| redness | (★2026-09 수정) 느슨한 피부 마스크 위 rg색도 nr가 중앙값+0.03 초과 비율 | 0.030 |
| poreDen | (★2026-09 수정) 반경4px 링 평균−자기휘도 > (12+1.5×노이즈추정) 인 점 비율 | 12/1.5/링4px |
| q(품질) | 0.30·light+0.28·focus+0.24·skinRatio+0.18·faceSkinRatio, ×glareOk | 여러 하드코딩 |

### 4. 부위 종합 — applyRegions()
```
tzOilC   = clamp(tz.shine / CAL.shineFull(0.11))
noseOil  = clamp(n.shine / 0.11)
pore     = clamp((n.poreDen − 0.010) / 0.045)      # 구데이터만 lap 폴백
cheekOil = clamp(ch.shine / 0.11)
cheekRed = clamp((ch.redness − 0.02) / 0.13)
oilSig   = tzOilC ?? noseOil ?? 0.3
  T존·볼 둘 다 있으면: rel=clamp((tz.shine−ch.shine)/0.05); oilSig = 0.55·rel + 0.45·oilSig
oily = 0.45·oilSig + 0.30·(noseOil??oilSig) + 0.10·(pore??oilSig) + 0.15·oilSig
dry  = 0.55·dryBase + 0.45·(볼기반)   # dryBase = (0.09−tz.shine)/0.09
acne = cheekRed ?? 코 폴백(같은 상수)
q    = 평균부위q × (0.55+0.45·부위수/3) × (얼굴검출시 1.08)
Sp   = normalize([oily+0.12, dry+0.12, acne+0.12])
idx  = PIDX(각 지수)   # PIDX(x)=10+86·√x — 표시용 √커브
```

### 5. 설문 — CORE(6) + FOCUS(2~3)
- 사진 힌트(dominantHint: photo.q≥0.4일 때 Sp argmax)로 FOCUS 세트 선택(oily/dry/acne/def).
- oily/dry 힌트면 acne 문항 1개 추가(트러블 통로 확보).
- 배점: 답변 문자열 `|o2d1` 식 인코딩. surveyVector에서 합산 후 **바닥값 o+=1.5, d+=1.4, a+=1.0** 더해 normalize.

### 6. 융합 판정 — fuse(Sv, photo)
```
qRamp = clamp((q−0.35)/0.30, 0, 1)             # (★2026-09 수정) 하드컷 → 램프
w_p = (regions? 0.45 : 0.30)·q·qRamp
F[i] = (1−w_p)·Sv[i] + w_p·Sp[i]
primary = argmax(F)
if F[2] ≥ CAL.troubleMin(0.28) → primary=C(트러블)   # 트러블 우선 규칙
elif F[2] > 0.24 or 사진Sp[2] > 0.45 → '여드름 주의' 플래그
conf = q·0.4 + margin/0.3·0.35 + (사진·설문 argmax 일치?1:0.4)·0.25
band = conf>0.7 '높은 확신' / >0.45 '보통' / 그 외 '낮은'
```

### 7. 출력
- 타입 매핑: 지성→타입 B, 건성→타입 A, 여드름→타입 C(복합).
- result-bw.html에 `type/fno/o/d/t/lc` 쿼리로 전달. lc=1(낮은 확신·사진 미사용)이면 결과 페이지가 숫자 대신 문장으로 말함.
- 근거 문구: reasonText() — 사진 사용 여부, T존 광택(shineDiff>0.06), 붉은기(>0.06), 부위 지수 인용.

## 하드코딩 상수 전수 목록

### 명명된 상수 (조정 지점)
- `CAL` — troubleMin 0.28 / shineFull 0.11 / dryZero 0.09 / redOffset 0.02 / redFull 0.13 / poreLo 70 / poreHi 620 / poreDenLo 0.0008(★재보정) / poreDenSpan 0.006(★재보정) / relOilW 0.55. 다수가 손보정 값 — 실기기 9회 측정으로 재확인 예정.
- `VF` — 위 게이트 표 참조.

### 이름 없는 매직넘버 (함수 안에 박힘)
| 위치 | 값 | 의미 |
|---|---|---|
| isSkin | 60/40/20/8/12 | RGB 피부 판정 경계 |
| isFaceSkin | 95, 0.345/0.475, 0.275/0.350, 0.015 | rg-chromaticity 경계 |
| analyzeRegionShot | 0.16/0.68 | ROI 비율 |
| 〃 | 640 | 분석 해상도 |
| 〃 | 500 | 색도 마스크 최소 픽셀(느슨 폴백 전환) |
| 〃 | 165, 0.75~1.35 | 휘도 게인 목표·클램프 |
| 〃 | 1.12/0.55~0.95, 0.26/0.20/0.18, 252, 16px | (★) shine 스페큘러 문턱·채도·클리핑·블록 |
| 〃 | 0.985 | 클리핑 판정 |
| 〃 | +0.030 | (★) redness 색도 오프셋 |
| 〃 | 12+1.5×노이즈, 2px, 링4px | (★) poreDen 국소최소 판정 |
| 〃 | q 가중 0.30/0.28/0.24/0.18, glareOk 0.15 | 품질 점수 |
| applyRegions | 0.05 | T존−볼 상대광택 정규화 폭 |
| 〃 | 0.45/0.30/0.10/0.15 | oily 가중 (oilSig 실효 0.60) |
| 〃 | 0.55/0.45/1.6 | dry 가중 |
| 〃 | 0.55/0.45/3, 1.08 | q 종합 가중 |
| 〃 | +0.12 | Sp 3축 공통 바닥 |
| fuse | 0.35~0.65 | (★) 사진 가중 램프 구간 |
| 〃 | 0.45/0.30 | 사진 가중 상한 |
| 〃 | 0.24/0.45 | 여드름 주의 플래그 |
| 〃 | 0.05/0.25 | 부분건성 플래그 |
| 〃 | 0.4/0.35/0.25, 0.3, 0.7/0.45 | conf·band |
| surveyVector | 1.5/1.4/1.0 | 3축 바닥값 |
| PIDX | 10+86√x | 표시 커브 |
| dominantHint | 0.4 | 힌트 q 컷 |

### 중복 정의 (2026-09-01 이후)
- ✅ diagnose-bw.html은 엔진 import — 복붙 중복 해소. 레거시 face 모드·analyzeROI 삭제됨.
- ✅ regionTheater() 모공 숫자 = 결과와 같은 poreDen 상수 사용.
- ⚠️ **diagnose.html에는 아직 옛 엔진 인라인** — -bw 디자인 적용 PR에서 엔진 import로 전환해야 완전 해소.
- `applyRegions`의 pore lap 폴백(poreLo/poreHi)은 구버전 데이터 전용 잔재 — 엔진 전환 완료 후 삭제 후보.
