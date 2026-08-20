/**
 * BfM 비전 정밀분석 + 측정데이터 수집 프록시 (Cloudflare Worker)
 * ─────────────────────────────────────────────────────────────
 * 상태: 준비됨 · 미배포 · 프론트 미연결 (4단계 스캐폴드)
 * 배포 전 필요한 것:
 *   1) Anthropic API 키 → `wrangler secret put ANTHROPIC_API_KEY`
 *   2) 수집용 KV 네임스페이스 → wrangler.toml에 MEASURES 바인딩
 *   3) `wrangler deploy` (계정: jands.jjangga7004.workers.dev 쓰던 그 계정이면 됨)
 *   4) 프론트 연결은 별도 PR — "AI 정밀 분석(베타)" 옵트인 버튼 + 동의 문구
 *      (사진 무전송 원칙의 옵트인 완화 — 대표 결정 완료, 동의 UX는 연재와 확정)
 *
 * 엔드포인트:
 *   POST /analyze  {image: dataURL(jpeg), consent: true}
 *     → Claude 비전으로 피부 상태 관찰 → {observations, oily, dry, trouble, note}
 *   POST /collect  {v: 스키마버전, m: 측정값들, survey, type, ts}
 *     → 익명 측정 로그 적재 (사진 없음 — 숫자만. 임계값 재보정 재료)
 */

const CORS = {
  'Access-Control-Allow-Origin': '*', // 배포 시 https://www.bfm.best 로 좁힐 것
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'content-type',
};

const SYSTEM = `당신은 화장품 브랜드의 피부 관찰 보조입니다. 셀피에서 관찰 가능한 것만 서술하세요.
규칙(화장품법 표시광고 — 위반 시 응답 폐기됨):
- 의학 용어 금지: 진단·치료·염증·질환·여드름균 등 사용 금지. '트러블 경향', '붉은 기', '유분감' 같은 관찰 표현만.
- 측정하지 않은 수치를 만들지 말 것. 확신 없으면 "사진으로는 판단이 어려움"이라고 말할 것.
- 출력은 JSON 하나: {"observations":["관찰1","관찰2","관찰3"],"oily":0~1,"dry":0~1,"trouble":0~1,"note":"한 줄 요약"}
- oily/dry/trouble은 사진에서 받은 인상의 상대 강도(합이 1일 필요 없음).`;

export default {
  async fetch(req, env) {
    if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });
    if (req.method !== 'POST') return new Response('method', { status: 405, headers: CORS });
    const url = new URL(req.url);

    if (url.pathname === '/analyze') {
      const { image, consent } = await req.json().catch(() => ({}));
      if (!consent) return json({ error: 'consent_required' }, 400);
      const m = /^data:image\/(jpeg|png);base64,(.+)$/s.exec(image || '');
      if (!m) return json({ error: 'bad_image' }, 400);
      const r = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'x-api-key': env.ANTHROPIC_API_KEY,
          'anthropic-version': '2023-06-01',
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          model: 'claude-haiku-4-5-20251001',
          max_tokens: 500,
          system: SYSTEM,
          messages: [{
            role: 'user',
            content: [
              { type: 'image', source: { type: 'base64', media_type: 'image/' + m[1], data: m[2] } },
              { type: 'text', text: '이 피부 사진을 관찰하고 규칙대로 JSON만 출력하세요.' },
            ],
          }],
        }),
      });
      if (!r.ok) return json({ error: 'upstream', status: r.status }, 502);
      const body = await r.json();
      const text = (body.content?.[0]?.text || '').trim();
      const jm = text.match(/\{[\s\S]*\}/);
      if (!jm) return json({ error: 'no_json' }, 502);
      let out; try { out = JSON.parse(jm[0]); } catch { return json({ error: 'parse' }, 502); }
      // 금지어 안전망 — 모델이 실수해도 프론트에 안 나가게
      const banned = /진단|치료|염증|질환|균|피부염|의사|처방전/;
      out.observations = (out.observations || []).filter(s => !banned.test(s)).slice(0, 4);
      if (banned.test(out.note || '')) out.note = '';
      return json(out);
    }

    if (url.pathname === '/collect') {
      const data = await req.json().catch(() => null);
      if (!data || data.v !== 1) return json({ error: 'bad_schema' }, 400);
      if (JSON.stringify(data).length > 4096) return json({ error: 'too_big' }, 400);
      const key = new Date().toISOString().slice(0, 10) + '/' + crypto.randomUUID();
      await env.MEASURES.put(key, JSON.stringify({ ...data, ua: req.headers.get('user-agent')?.slice(0, 80) }));
      return json({ ok: true });
    }

    return new Response('not found', { status: 404, headers: CORS });
  },
};

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), { status, headers: { ...CORS, 'content-type': 'application/json' } });
}
