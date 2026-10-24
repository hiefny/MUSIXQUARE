# iOS에서 스펙트럼 눈금선이 파랗게 보이는 문제 (2026-10-25)

- Status: 9.0.8 버그 수정·검증 기록이다. 이 PR은 9.0.8 / v779로 올린다. 오너 결정(2026-10-25)으로 YouTube
  싱크 수정과 한 번의 9.0.8 배포로 나가고, 그 배포와 기록은 YouTube 싱크 작업이 맡는다(SW 캐시만 한 번 더
  올림). 배포 결과의 정본은 [릴리스 기록](../release-record.md)과 [릴리스 이력](../release-history.md)이다.
- 계기: 오너 제보(2026-10-25). 최신 iOS(Safari와 홈 화면 앱)에서 스펙트럼 비주얼라이저의 100 Hz, 1000 Hz,
  10000 Hz 눈금선이 회색이 아니라 파란색으로 보인다. 트랙을 재생하면 회색으로 돌아오고, 멈춘 채 원형으로
  바꿨다가 다시 스펙트럼으로 바꾸면 다시 파랗다.
- 커밋: `2b25c30f`(수정과 시험), 릴리스 식별자 `6499cbf4`(9.0.8 / v779, 마지막 런타임 커밋).

## 원인

원인 커밋은 8.11.40의 [`264fd5db`](https://github.com/hiefny/MUSIXQUARE/commit/264fd5db)(#442)다. 8.11.40은
따로 배포되지 않고 9.0.0(2026-10-22 07:34 KST)에 실려 나갔으므로, 운영에서는 9.0.0부터 생긴 문제다.

`264fd5db`는 스펙트럼 눈금선을 `src/ui/visualizer-spectrum-static.ts`로 옮기면서 세로 그라디언트 하나를
캐시해, 컨텍스트·크기·테마·변환이 같으면 같은 `CanvasGradient` 객체를 매 그리기마다 다시 썼다. 그 전
(`264fd5db^`의 `src/ui/visualizer.ts` `drawSpectrumGrid`)에는 선마다 새 그라디언트를 만들었다.

같은 그라디언트 객체를 다시 쓰는 것 자체는 캔버스 규격상 문제가 없다. 문제는 iOS·iPadOS에서 캔버스를 GPU
프로세스로 그리는 WebKit의 기록기(`RemoteGraphicsContextProxy`)가 붓 상태를 추적하는 방식과 겹친 데 있다.
아래는 WebKit 소스를 읽어 확인한 동작이고, 실기기에서 기록기 내부를 직접 관찰한 것은 아니다.

1. 기록기는 마지막으로 GPU 쪽에 보낸 상태(`lastDrawingState`)를 기억하고, 새로 지정한 값이 그것과 같으면
   변경으로 표시하지 않는다(`Recorder::didUpdateSingleState` → `GraphicsContextState::mergeSingleChange`).
   그라디언트 붓은 같은 그라디언트 객체(포인터)이고 변환(spaceTransform)이 같으면 같다고 본다
   (`SourceBrushLogicalGradient` 비교). 붓에는 그라디언트와 별도로 마지막 단색 값이 남는다
   (`SourceBrush::setGradient`는 색을 지우지 않는다). 그리기 호출 때 표시된 변경이 있으면 그것을 보내고 상태
   전체를 기억한다(`appendStateChangeItemIfNecessary`).
2. 한 구간짜리 단색 직선은 색과 두께를 실어 묶음으로 보낸다(`inlineStrokeStateIfBatchable`). 이때 기억한
   붓은 색만 바꾸고(`lastDrawingState->strokeBrush().setColor(...)`, 주석 "Set through strokeBrush() to
   avoid comparison") 그 전 그라디언트는 그대로 남긴다. GPU 쪽은 그 단색으로 바뀐다.
3. 멈춤 화면의 스펙트럼은 눈금선(그라디언트 G로 세로선 셋) 다음에 바닥 정지선(`rgba(59, 130, 246, 0.38)`
   한 구간 직선)을 그린다. 정지선이 2의 묶음 경로를 타므로 기억한 붓은 {파랑, G}가 된다.
4. 다음 그리기에서 같은 G를 다시 지정하면 붓은 {파랑, G}로, 기억한 붓과 같아 상태 변경이 생략된다. GPU
   쪽에는 정지선의 파랑이 남아 있으므로 눈금선 셋이 파랑으로 그려진다.

오너 재현과 맞춰 보면 이렇다.

- 멈춘 채 모드를 바꾸면 `setVisualizerMode`가 `drawRestingVisualizerFrame()`을 부르고 이어서
  `startVisualizer()`가 재생 중이 아니므로 다시 `drawRestingVisualizerFrame()`을 부른다. 캐시는 마지막
  스펙트럼 크기와 비교하므로 왕복 뒤에도 같은 G를 쓴다. 원형 화면을 그릴 때 채우기 색이 바뀌어 상태 전체가
  다시 기억되므로(캔버스 크기가 바뀌면 기록기 자체가 새로 시작된다) 돌아온 첫 그리기에서는 G가 새 값으로
  보내져 회색이다. 그 첫 그리기의 정지선이 다시 3을 만들어, 바로 이어지는 두 번째 그리기에서 눈금선이 파랗게
  된다. 테마 변경·화면 크기 변화·화면 복귀처럼 정지 화면을 연달아 다시 그리는 다른 경로도 같은 결과를 낸다.
- 재생 중에는 매 프레임 여러 구간짜리 곡선을 그린다. 곡선은 묶음 경로가 아니라 일반 상태 전송을 타서 기억한
  붓 전체({파랑 0.9, 그라디언트 없음})를 새로 적는다. 그래서 다음 프레임의 G는 다른 붓으로 판정되어 전송되고
  눈금선이 회색이다.

WebKit main은 2026-08의 기록기 재구성([6c4ecf6](https://github.com/WebKit/WebKit/commit/6c4ecf631b),
[6571377](https://github.com/WebKit/WebKit/commit/65713772d8))에서 이 장부를 "보낸 상태 사본"으로 바꿔
묶음 경로도 붓 전체를 복사한다(`commitStateChanges` → `copyPropertiesFrom`). 색만 바꾸는 갱신은 적어도
[cb0ff89](https://github.com/WebKit/WebKit/commit/cb0ff890b9)(2025-08-20)부터 6월의 묶음 전송 최적화
([564c069](https://github.com/WebKit/WebKit/commit/564c069cbc), 314520@main, 2026-06-04)까지의 코드에 있다.
그 전 코드와, 어느 iOS 버전에 어느 쪽이 들어 있는지는 확인하지 않았다. 같은 GPU 프로세스 캔버스를 쓰는
macOS Safari에서도 생길 수 있지만 확인하지 않았다.

## 변경

`drawSpectrumGrid`가 그릴 때마다 그라디언트를 새로 만든다(세로선 셋은 한 그라디언트를 같이 쓴다). 캐시와
`getTransform` 의존을 지웠다. 새 객체는 기록기가 기억한 그라디언트와 포인터가 달라 항상 전송된다(기억한 붓이
옛 그라디언트를 참조로 잡고 있으므로 주소가 재사용되지도 않는다). 색·두께·위치·그리는 순서, 재생 중 곡선,
디더 패턴 캐시, 원형 시각화는 그대로다. 프레임당 그라디언트는 `264fd5db` 전의 셋에서 하나로 줄어든 상태를
유지한다.

## 검증

- 단위(먼저 실패 확인): `src/ui/__tests__/webkit-stroke-recorder.ts`에 위 1·2의 장부(획 붓·채우기 색·선
  두께만, save/restore 단계는 빼고)를 흉내 낸 캔버스 대역을 두고 세 시험을 더했다.
  - `visualizer-spectrum.test.ts`: 그리기마다 새 그라디언트를 쓰고 세 선이 그것을 같이 쓰는지, 테마별 색
    정지점이 맞는지 본다.
  - `visualizer-spectrum.test.ts`: 정지 화면(눈금선 + 정지선)을 두 번 그려 눈금선 여섯 번이 모두 그라디언트로
    칠해지는지 본다.
  - `visualizer.test.ts`: 멈춤 상태에서 실제 모드 전환(스펙트럼 → 원형 → 스펙트럼)으로 같은 것을 본다.

  `visualizer-spectrum-static.ts`만 `cae7a118` 것으로 바꿔 돌리면 셋 다 실패한다. 그라디언트는 한 번만
  만들어지고, 정지 화면 두 번째의 눈금선 셋과 왕복 뒤 두 번째 프레임의 눈금선 셋이 정지선 파랑이다(왕복 뒤
  첫 프레임은 회색). 수정 후에는 통과한다. 캐시의 무효화 조건을 보던 두 시험은 캐시가 없어져 지웠다.
- 브라우저(e2e 빌드, 임시 Playwright 시험, 커밋하지 않음): 수정 전은 `2b25c30f` 트리에서
  `visualizer-spectrum-static.ts`만 `cae7a118` 것으로 바꾼 빌드, 수정 후는 `2b25c30f` 빌드다(`6499cbf4`와는
  버전 문자열만 다르다). Playwright 1.63.0의 Chromium(Chrome for Testing 153, 1440×900)과 WebKit(r2359,
  Windows, iPhone 13 에뮬레이션)에서 다크·라이트 각각 원형 → 스펙트럼 왕복 뒤
  100 Hz·1 kHz·10 kHz 선의 캔버스 픽셀을 읽었다. Chromium은 로컬 PeerJS 방장으로 test01을 재생 → 멈춤 뒤
  왕복했다. 이 WebKit은 PeerJS 신호와 test01 디코딩이 안 되어 `back-navigation` 시험과 같은 방장 역할
  대역으로 들어가 유휴(재생 아님) 상태에서 왕복했다. 멈춤과 유휴는 같은 정지 화면 경로를 탄다.

  | 브라우저 · 테마 | 수정 전 왕복 뒤 | 수정 후 왕복 뒤 |
  | --- | --- | --- |
  | Chromium 다크 | (255,255,255) α10·10·15 | 같음 |
  | Chromium 라이트 | (0,0,0) α10·10·15 | 같음 |
  | WebKit 다크 | (255,255,255) α15·15·15 | 같음 |
  | WebKit 라이트 | (0,0,0) α15·15·15 | 같음 |

  Chromium의 재생 중·멈춤 직후 값도 전후가 같다. 두 브라우저 모두 수정 전에도 회색이라 이 환경에서는 결함이
  재현되지 않는다. Windows용 Playwright WebKit은 iOS의 GPU 프로세스 캔버스 기록기를 거치지 않기 때문으로
  본다. 그래서 이 확인은 수정이 화면을 바꾸지 않는다는 근거이고, 결함이 고쳐졌다는 근거는 위 단위 시험과
  WebKit 소스다.
- 로컬 Windows, Node 24.20.0, `6499cbf4`(마지막 런타임 커밋): `npm run typecheck`, `typecheck:tests`, lint,
  format 통과. unit 661 files / 15,305 pass / 0 fail / 0 skip. `build:checked` 통과(release-identity 9.0.8 /
  v779, sw-cache-version, 초기 전송 예산 포함). `node --check cloudflare/app-worker.ts`와 가드
  developer-api-boundaries·d1-migrations·ops-drift-contract·dead-exports·bus-pairing·transport-health,
  `check-resource-ownership`(48 records) 통과.
- 독립 검토(별도 에이전트) 뒤 시험만 고친 `7ee500fe`: 대역 모형을 위처럼 정확히 하고, 옛 캐시가 시험에서
  꺼지지 않게 대역에 `getTransform`을 두었다. 그 SHA에서 두 시험 파일 39/39 통과, 옛 정적 파일로는 위 세
  시험 실패를 다시 확인했다. 로컬 결과는 exact-main CI 후보를 대신하지 않는다.

## 실기기 확인 절차 (오너)

배포 뒤 iPhone에서, 9.0.8로 갱신된 것을 확인하고(업데이트 창의 "적용하기" 또는 다시 열기) 진행한다.

1. Safari와 홈 화면 앱 각각, 다크와 라이트 각각에서 방에 들어가 로컬 트랙 하나를 올린다.
2. 스펙트럼으로 두고 재생해 눈금선 셋이 회색인지 본다.
3. 멈춘다. 눈금선이 회색인지 본다.
4. 비주얼라이저를 눌러 원형으로 바꿨다가 다시 눌러 스펙트럼으로 돌린다. 눈금선 셋이 회색인지, 바닥 정지선만
   파란지 본다. 이 단계를 세 번 반복한다.
5. 멈춘 채 기기를 가로로 돌렸다가 세로로 돌리고, 앱을 백그라운드로 보냈다가 돌아온다. 눈금선이 회색인지 본다.

어느 단계든 눈금선이 파랗다면 iOS 버전과 단계를 알려 주면 된다.

## Release and recovery

오너 결정(2026-10-25)으로 이 수정은 YouTube 싱크 수정([#484](https://github.com/hiefny/MUSIXQUARE/pull/484))과
한 번에 9.0.8 / v780으로 배포됐다. 9.0.8 / v779는 배포 전이라 캐시 epoch만 v780으로 올렸다. main `8c3fdcab`
(이 수정은 `bd94075c`)로 [Release 40122870289](https://github.com/hiefny/MUSIXQUARE/actions/runs/40122870289)는
App 배포 뒤 Standard HTTPS signaling smoke의 일시 502로 9.0.7로 자동 복구됐고(최종 경계 verified), 같은 SHA의
[Release 40123156024](https://github.com/hiefny/MUSIXQUARE/actions/runs/40123156024)가 2026-10-25 04:00 KST에
성공했다(App `1513bc69`, smoke 모두 success, 공개 SW v780,
[Drift 40123389462](https://github.com/hiefny/MUSIXQUARE/actions/runs/40123389462) 31 pass / 0 fail / 5
manual-only). release-record §2에 iPhone 확인 항목을 두었다. 되돌리면(App을 9.0.7 / v778로) iOS에서 멈춤
화면의 눈금선이 다시 파래지고 일반방 YouTube 수정이 함께 빠진다.

## 한계

실제 iPhone에서 결함과 수정을 확인하지 않았다(위 절차는 오너 몫). 원인은 WebKit 소스와 그 동작을 흉내 낸
단위 시험으로 밝혔고, 오너 기기의 iOS 버전에 해당 WebKit 코드가 들어 있는지는 확인하지 않았다. macOS
Safari는 확인하지 않았다.
