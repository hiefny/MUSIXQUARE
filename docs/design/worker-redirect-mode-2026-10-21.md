# Worker fetch의 지원하지 않는 redirect 값 수정 (2026-10-21)

- Status: 수정·검증 기록이다. 배포 결과의 정본은 [릴리스 기록](../release-record.md)과
  [릴리스 이력](../release-history.md)이다.
- 계기: 8.11.32 배포 뒤 블로그 사진 응답의 `X-Soro-Image-Mirror`가 `error`였다(오너가 원인 수정을 요청).

## 원인

Cloudflare Workers 런타임은 `fetch`·`Request`의 `redirect` 값으로 `follow`와 `manual`만 받는다. `error`를 주면 네트워크에
나가기 전에 `TypeError: Invalid redirect value, must be one of "follow" or "manual"`을 던진다. 로컬 workerd(wrangler dev
`--local`, 운영과 같은 compatibility date `2026-05-04`)에서 같은 Supabase 이미지 주소로 확인했다: `error`는 예외, `manual`과
`follow`는 200 `image/webp`. 단위 테스트는 Node의 가짜 fetch로 돌아 이 차이가 드러나지 않았다. 브라우저와 Node 코드
(`src/`, `scripts/`)의 `redirect: 'error'`는 정상 값이라 그대로 둔다.

Worker에서 실제로 실행되던 곳은 세 군데다.

| 위치                                                          | 도입                                         | 영향                                                                          |
| ------------------------------------------------------------- | -------------------------------------------- | ----------------------------------------------------------------------------- |
| `cloudflare/app-worker.ts` 블로그 사진 R2 사본 받기           | `d6d566d9` (2026-09-04)                      | 사본을 한 번도 저장하지 못했다. 8.11.32부터는 원본 주소로 302해 사진은 보였다 |
| `cloudflare/pro-youtube-duration.ts` PRO → App 내부 길이 요청 | `972555c3` (2026-10-12, 8.9.5 PRO 자율 재생) | PRO Worker가 YouTube 길이를 요청하는 순간 예외가 나 재시도로만 처리됐다       |
| 같은 파일의 App → YouTube Data API 요청                       | 같음                                         | 위 요청이 도착했더라도 같은 예외로 실패했다                                   |

그래서 8.9.5부터 PRO 서버는 컨트롤러가 없을 때 YouTube 곡 길이를 서버에서 얻지 못했을 가능성이 크다. 릴리스 기록의
"PRO 자동 넘김 길이 판독" 항목에서 지켜보던 메타데이터 조회 실패와 같은 원인으로 본다(운영 로그로는 아직 확인하지 않았다).

## 변경

- 세 곳을 `redirect: 'manual'`로 바꿨다. 세 곳 모두 이미 2xx(또는 200)가 아니면 실패로 처리하므로, 3xx 응답은 따라가지
  않고 지금처럼 실패가 된다(외부 주소로 끌려가지 않는 보안 성질 유지).
- 새 가드 테스트 `src/core/__tests__/worker-redirect-mode.test.ts`가 `cloudflare/`의 Worker 코드에 `redirect: 'error'`가
  다시 들어오면 실패한다. 기존 테스트의 기대값도 `manual`로 바꿨다.

## 배포 범위

블로그 사진은 App Worker만으로 고쳐진다. PRO 길이 조회는 PRO Worker(`pro-room-worker.ts`가 요청을 만든다)와 App Worker(요청을
받아 YouTube API를 부른다)를 함께 배포해야 고쳐진다.

## 검증

- 로컬 workerd 탐침으로 런타임 동작을 확인했다(위). 수정한 App·PRO Worker 전체를 로컬 workerd로 돌리지는 않았다.
- 단위: `worker-redirect-mode`, `app-worker-cors`, `pro-youtube-duration`, `natural-completion-integration`,
  `pro-room-worker` 5 files / 825 pass.
- 배포 뒤 확인: 블로그 사진 주소가 302 대신 R2에서 200으로 오고 `X-Soro-Image-Mirror`가 없어지는지, PRO 방에서 컨트롤러
  없이 YouTube 곡이 길이대로 넘어가는지.
