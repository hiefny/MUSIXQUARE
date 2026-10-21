# 비주얼라이저 최적화의 UI·UX·호환성 사전 재검증 — 2026-10-22

| 항목 | 범위 |
| --- | --- |
| 성격 | 구현 전 검토 및 제한된 1회 비교. 최종 제품 수정의 합격 판정이 아님 |
| 기준 코드 SHA | `a1548d90d5e68573d19696dfd2bdd5a6efe29bce`, App 8.11.38 |
| 환경 | Windows, Node 24.13.1, Chromium 153.0.8010.12, Playwright WebKit 26.6 |
| 선행 근거 | [최적화 조사](visualizer-optimization-audit-2026-10-22.md) |
| 실행 범위 | 항목별 소스 재검토, Canvas 픽셀 비교 1회, 신호 비교 1회, 수명주기 비교 1회 |
| 제품 변경 | 없음. 새 의존성·프로토콜·저장 형식·배포·오너 승인 조건을 만들지 않음 |

## 결론과 수정할 제안

모든 제안을 동일한 모양을 유지하는 성능 개선으로 취급할 수는 없다.
특히 **Canvas 그리기 중단과 공유 analyser 읽기 중단은 다른 변경**이다.
주파수 대역·시간 보정·스펙트럼 집계는 음악에 반응하는 표현을 바꾼다.

| 항목 | UI·UX 절충 | 적용 시 지킬 조건 |
| --- | --- | --- |
| 정적 grid gradient 캐시 | 이번 격리 비교에서 픽셀 차이 없음 | context·높이·padding·테마·backing 크기·transform 변경 시 갱신. 기존 stroke 순서 유지 |
| 곡선 계산 재사용 | 이번 비교에서는 동일. 닫힌 fill path를 그대로 stroke하면 옆·아랫선이 생김 | 윗곡선 stroke와 닫힌 fill을 구분. 새 할당이 계산 절감보다 커지지 않게 함 |
| 마지막 점 배열의 중복 복사 제거 | 소유권을 유지하면 기존 held frame 보존 가능 | 활성 loop와 보존 frame 사이의 수명 보장. 전역 pool·동시 loop 공유는 하지 않음. 구현 검증은 별도 |
| 가려진 Canvas 중단 | 전환 중 멈춤·복귀 시 초기화가 생길 수 있음 | 완전 가림 뒤 그리기 중단, 닫기 fade 전에 재개, pause/hold와 visibility suspend 분리 |
| Hz 기준 대역 | 반응하는 악기·원 크기·보호기 밝기가 바뀜 | 대역 고정과 기존 모양 보존을 구분. 기존 48 kHz 표현을 기준으로 보정하는 안을 우선 비교 |
| 시간 기준 보정 | 60 Hz에 맞추면 고주사율에서는 지금보다 느긋하게, 저주사율에서는 빠르게 반응 | 60 Hz를 기준으로 명시하고 analyser 단계도 별도로 검토 |
| analyser 읽기 빈도 감소 | 공격·잔상과 보호기 밝기가 바뀜 | 현재 smoothing 그대로 30 Hz로 감속하는 제안은 제외. 공유 읽기의 소유권·빈도 먼저 설계 |
| 스펙트럼 구간 집계 | 피크가 복원되며 곡선이 높고 두꺼워질 수 있음. JS 집계도 증가 | max와 power mean의 표현 차이를 결정. 순수 속도 개선으로 분류하지 않음 |
| 동작 줄이기 | 음악의 시각적 반응을 줄이거나 없앰 | OS 설정에 따른 접근성 정책. 모드 선택·저장·키보드 조작·held frame 유지 |

## 가림·복귀에서 보존해야 하는 것

[보호기](../../src/ui/screensaver.ts)는 420 ms opacity 전환을 사용한다. overlay가
DOM에 존재하거나 배경이 `inert`라는 이유만으로 즉시 멈추면, 아직 보이는 그림이
전환 도중 정지한다. 완전히 덮을 때까지 잠시 더 그리는 비용은 연속성을 위해 유지한다.
부분적인 대화상자 뒤 배경도 일괄 중단하지 않는다.

[overlay stack 알림](../../src/ui/dom.ts)은 append/remove뿐 아니라
`beginBackSurfaceTransition()`의 시작·완료에도 발생한다. 이번 수명주기 검사의
"append/remove 때만 각 1회"라는 기대는 두 모드 모두 실패했고, 소스에서 이 추가
알림을 확인했다. 닫기 시작 알림은 `opacity = 0` 대입보다 먼저 발생한다.
따라서 알림 횟수나 즉시 읽은 opacity로 전환 단계를 추측하지 않는다. 열기 fade가
완료됐는지도 별도로 판정해야 한다. 이 결과로 "닫기 시작 알림이 전혀 없다"는
초기 해석은 채택하지 않는다.

기본 IntersectionObserver는 다른 요소가 그림을 덮은 사실을 판정하지 않는다.
Chromium 격리 검사에서도 완전 불투명 보호기 뒤의 wrapper는 intersecting이었다.
스크롤 밖 감지와 명시적인 완전 가림 상태를 함께 사용하고, 미지원 시에는 기존
렌더링으로 돌아가는 보수적인 fallback을 둔다. 실험적
[`trackVisibility`](https://developer.mozilla.org/en-US/docs/Web/API/IntersectionObserver/trackVisibility)를
필수 조건으로 사용하지 않는다.

[데모](../../src/demo/mode.ts)는 실제 wrapper를 다른 컨테이너로 옮기며,
데스크톱은 패널들이 동시에 보인다. `tab-play.active`만 검사하지 않는다.
기존 모드 기억·데모에서의 spectrum 고정·키보드 접근성도 유지해야 한다.

[현재 새 시작](../../src/ui/visualizer.ts)은 원형 smoothing을 0부터 시작하고,
스펙트럼은 마지막 frame을 버린 뒤 두 번 휴지선을 그린다. 단순 재노출마다 이를
실행하면 그림이 다시 커지거나 바닥선이 나타난다. 가시성 suspend는 재생의 새
시작과 구분하고, 사용자가 멈춘 frame과 resize/theme 처리를 보존해야 한다.

## 공유 analyser와 음악 반응

[보호기의 저음 효과](../../src/ui/screensaver-bass.ts)도 같은 analyser를 읽는다.
원형 모드의 analyser smoothing은 0.3, spectrum은 0.8이고 spectrum warmup 중에는
잠시 0이다. warmup 중 취소할 때 임시 설정이 남지 않게 정리해야 한다.
보호기만 보이는 동안 비주얼라이저의 읽기를 제거하면 공유 분석의 갱신 빈도와
보호기의 반응도 달라질 수 있다. 보호기의 별도 시간 보정만으로 상쇄되지 않는다.

실제 Chromium OfflineAudioContext에서 동일한 1 kHz 음을 0.1초에 켜고 0.5초에
끈 뒤 smoothing 0.8을 유지하고 읽기 빈도만 바꿨다. 아래는 약 0.2/0.8초의
가장 가까운 render-quantum 시점에서 읽은 peak다.

| 읽기 빈도 | 약 0.2초 | 약 0.8초 |
| --- | ---: | ---: |
| 30회/초 | −22.21 dB | −30.51 dB |
| 60회/초 | −18.66 dB | −44.87 dB |
| 120회/초 | −15.92 dB | −74.47 dB |

단순히 느리게 읽으면 공격과 잔상이 달라진다. 이는 analyser 단계의 비교이며
최종 원 크기·음악 청취·실제 보호기 화면의 A/B가 아니다. 분석 결과를 이전
magnitude와 합친 뒤 dB로 변환하는 구조는
[Web Audio 1.1 초안의 smoothing 정의](https://www.w3.org/TR/webaudio-1.1/#fft-windowing-and-smoothing-over-time)와도 부합한다.

예시 대역 0–140 Hz / 7.5–20 kHz는 확정안이 아니다. 60 Hz 단일음에서 bass 값은
48 kHz에서 68.73→68.73, 44.1 kHz에서는 86.01→74.99, 96 kHz에서는 78.80→143.04였다.
대역에 들어오는 bin 수와 평균 분모가 바뀌기 때문이다. 48 kHz에서 18 kHz 단일음의
high 값도 1.270→0.732로 바뀌고, 기존에 제외됐던 8/12 kHz가 반응에 포함된다.
Hz 고정은 의미를 일관되게 만들지만 기기별 원 크기까지 같게 만들지는 않는다.

스펙트럼의 생략 구간에 19,828.125 Hz 단일음을 넣으면 현재 양옆 선택 bin은 약
−191/−194 dB여서 화면에 피크가 드러나지 않았다. 생략 구간의 max는 −15.21 dB,
power mean은 −26.82 dB였다. 집계 방식 사이에도 11.61 dB 차이가 있어 표시 방식
결정이 필요하다. 48 kHz에서 읽는 값도 약 310개에서 약 1,700개로 늘 수 있다.

시간 보정 자체의 수식 비교에서는 입력 변화 100 ms 후 반영량이 기존
30/60/120 Hz에서 48.8%/73.8%/93.1%이고, 60 Hz 기준 elapsed 보정은 모두
73.8%였다. 이것은 원형의 앱 단계만 계산한 값이며 analyser까지 동일해졌다는 뜻은 아니다.

## 호환성과 한 번의 검증 결과

- **Canvas PASS 144/144:** Chromium 153·WebKit 26.6 각각 72회 픽셀 비교.
  두 크기(604×240, 360×180), DPR 1/2/3, light/dark, 실제 dither와
  강제로 `createPattern`을 제거한 gradient fallback에서 grid 캐시·midpoint 재사용·
  Path2D 재사용을 비교했다. 모든 RGBA 차이는 0. 성능이나 전체 제품 적용의 합격은 아니다.
- **신호 비교 19조건 완료:** 단일음 15조건, 생략 피크 1조건, 읽기 빈도 3조건.
  차이를 찾는 비교이므로 같은 결과여야 하는 pass gate로 집계하지 않는다.
- **Chromium 수명주기 18 PASS / 2 FAIL:** 원형·스펙트럼 각각 held frame 정지,
  숨김/재노출 후 held 픽셀 보존, 테마 변경 후 정지, 재생 재개, 열기/닫기의 부분
  투명 상태, IO의 가림 미감지, 데모 mode/preference/accessibility와 복원, page error
  부재를 확인했다. 실패 2건은 위의 overlay 알림 횟수 가정이며 제품 결함으로 세지 않는다.
  각 조건은 한 번만 실행했고 실패한 기대를 바꿔 재실행하지 않았다.
- **WebKit 오디오 수명주기 미완료:** 이 Windows Playwright WebKit 실행에서는
  `AudioContext`가 없어 초기화가 실패했고 나머지 수명주기 검사는 수행하지 않았다.
  제품의 Safari 오디오 미지원이라는 뜻이 아니며 mock으로 대체해 통과로 만들지 않았다.
  별도의 순수 Canvas 72개 비교는 정상 완료했다.
- **미실행:** 기존 단위 28개 재실행, 전체 E2E·프로덕션 빌드·live 서비스, 실제 음악,
  물리 iPhone/Android·Safari 15·Chrome 79/TV, 실제 고주사율 화면, 전력·발열·장시간 성능.

현재 JS 빌드 기준은 [Chromium 79](../../scripts/browser-target.ts), CSS 대상에는
Safari/iOS 15가 포함된다. 기존 Canvas API·Math 기반 변경에는 브라우저 기준 상향이
필요하지 않다. Path2D도 문서상 Chrome 36·Safari 8부터 지원되지만 실제 구형 TV를
검증한 것은 아니다([MDN 호환성 원본](https://raw.githubusercontent.com/mdn/browser-compat-data/main/api/Path2D.json)).
새 라이브러리·OffscreenCanvas·worker 전환은 이 범위에 필요하지 않다.

`release-record.md`에는 배포 당시 초기 JS gzip 여유가 약 0.25 KiB로 기록돼 있다.
visualizer는 즉시 import되므로 구현 뒤 기존 빌드 예산 검사가 필요하다. 이번 검토가
추가 코드의 예산 통과를 보장하지 않는다. 오디오 출력 경로·방 통신·저장 형식은
바꿀 필요가 없으며 혼합 App 버전 프로토콜 변경도 계획하지 않는다.

이번에는 구현 전 제안과 검증 근거만 보완했다. 기존 운영 열린 항목·릴리스 범위·
복구 조건을 바꾸지 않아 릴리스 기록과 이력은 유지한다.
