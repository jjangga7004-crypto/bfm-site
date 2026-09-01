# BfM Skin Engine — 디자이너 인계 가이드

`bfm-skin-engine.js` 하나가 진단의 전부입니다. **디자인(HTML/CSS/화면 흐름)을 통째로 갈아엎어도,
이 모듈만 import해서 아래 6개 함수를 순서대로 부르면 진단이 똑같이 동작합니다.**
서버 없음 · 외부 API 없음 · 사진은 브라우저 밖으로 안 나감.

레퍼런스 구현(실제로 이 엔진을 쓰는 화면): `diagnose-bw.html` — 화면을 새로 만들 때
호출부만 이 파일에서 복사하면 됩니다.

## 사용법 (전체 흐름)

```html
<script type="module">
import * as ENGINE from './engine/bfm-skin-engine.js';

// ① 부위 사진 3장 — 캔버스에 그려서 넘긴다 (T존 → 볼 → 코, 일부 생략 가능)
const regionData = {
  tzone: ENGINE.analyzeRegionShot(tzoneCanvas, 'tzone'),
  cheek: ENGINE.analyzeRegionShot(cheekCanvas, 'cheek'),
  nose:  ENGINE.analyzeRegionShot(noseCanvas,  'nose'),
};
// 각 결과: {shine, redness, poreDen, q(품질 0~1), reason(재촬영 사유 or null), ...}
// reason이 'noskin'|'dark'면 재촬영 권유 화면을 보여줄 것

// ② 부위 종합 → 사진 판정
const photo = ENGINE.combineRegions(regionData);
// {Sp:[유분,건성,트러블], q, idx:{tzOil,noseOil,pore,cheekOil,red}(0~100 표시지수)}

// ③ 설문 문항 생성 (사진 힌트에 따라 8~9문항이 조정됨)
const Q = ENGINE.buildSurveyQuestions(photo);   // 사진 없으면 null 전달
// Q[i] = {sec:섹션명, q:질문, opts:[{t:보기문구,...}]}  → 화면에 그리기

// ④ 설문 점수화 — ans[i]는 사용자가 고른 보기 인덱스
const Sv = ENGINE.scoreSurvey(Q, ans);

// ⑤ 최종 판정
const r = ENGINE.fuse(Sv, photo);
// r.primary: 0=지성(B) 1=건성(A) 2=트러블(C) · r.typeKey: 'oily'|'dry'|'trouble'
// r.F: 3축 점수(막대그래프용) · r.band: '높은/보통/낮은 확신' · r.flags: ['여드름 주의' 등]
// ENGINE.PERSONAS[ENGINE.TYPES[r.primary]] → {name:'타입 B', tag:'...'} 표시용

// ⑥ 결과 근거 문구(HTML) — "왜 이 타입인지"
resultEl.innerHTML = ENGINE.reasonText(r, photo);
</script>
```

## 라이브 카메라 코칭 (선택)

촬영 화면에서 프레임마다 중앙 100×128 크롭의 ImageData를 넘기면 코칭 문구를 돌려줍니다:

```js
const fr = ENGINE.assessRegionFrame(imageData100x128.data, 100, 128,
  { region:'tzone', motion, face:{active, posBad, far, good} });
// fr.reason: 차단 사유 문구(null이면 촬영 가능) · fr.softNudge: 부드러운 안내
```
`motion`(프레임차)·`face`(BlazeFace 검출 상태)는 페이지가 계산해 넘깁니다 — `diagnose-bw.html`의
`loopRegion()` 참고. 능동형 가이드(가이드 SVG가 얼굴 따라 움직이는 것)는 화면 연출이라
엔진이 아니라 페이지에 있습니다: `updateGuideTransform()` 복사해 쓰세요.

## 판정 상수를 조정하고 싶을 때

- `CAL` — 판정 임계값(트러블 기준, 유분 정규화 등). **값을 바꾸면 반드시** 아래 스윕을 돌려
  A/B/C 분포와 일관성이 어떻게 변하는지 확인 후 커밋:
  ```
  node test/harness/run-baseline.mjs 라벨이름
  ```
  결과가 `test/baseline/라벨이름.json`으로 남고, 콘솔에 분포·일치율이 출력됩니다.
- `VF` — 촬영 게이트(밝기·초점·거리 등). 촬영이 너무 깐깐하다/헐겁다 할 때 조정.
- 문항·보기 문구는 `CORE`/`FOCUS` — 문구만 바꾸는 건 자유, `|o2d1` 같은 배점 코드를 바꾸면 판정이 변함.

## 지켜야 할 것

- **사진을 서버로 보내지 않는다** — 전부 브라우저 안에서 처리(제품 약속).
- 결과 문구에 의학적 효능·치료 단정 표현 금지(화장품 광고 규제). `reasonText`의 틀을 유지할 것.
- 엔진 파일을 페이지에 복붙하지 말 것 — import로만 사용(단일 소스 유지).
- `ENGINE_VERSION`이 판정 로직 버전 — 로직을 바꾸면 올리고, 결과 화면·수집 데이터에 함께 기록 권장.
