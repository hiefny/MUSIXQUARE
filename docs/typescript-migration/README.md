# TypeScript 전환 제어 문서

상태: **authoritative**
기준일: 2026-08-17

이 디렉터리는 MUSIXQUARE 저장소의 직접 작성 JavaScript를 TypeScript로 전환한
완료 기록이자 zero-JavaScript 불변식의 현재 제어면이다. 현재 상태와 완료 판정,
재도입 방지 규칙은 이곳을 기준으로 판단하며, 전환 순서와 rollout 단계는 역사 기록이다.

## 목표

최종 목표는 다음 명령이 아무 경로도 출력하지 않는 상태다.

```powershell
git ls-files "*.js" "*.mjs" "*.cjs" "*.jsx"
```

브라우저와 Cloudflare가 실행하는 빌드 산출물은 JavaScript일 수 있다. 여기서
제거하는 것은 **Git에 추적되는 직접 작성 JavaScript 계열 소스**다. `dist/`, Wrangler
번들, 외부 CDN/vendor 산출물처럼 재현 가능한 생성물은 전환 대상 소스가 아니다.

## 문서 지도

- [ROADMAP.md](./ROADMAP.md): 완료된 전환에서 사용하도록 설계한 역사적 의존 순서,
  품질 게이트, rollout·rollback 기록. 현재 배포 절차로 사용하지 않는다.
- [STATUS.md](./STATUS.md): 현재 수치, 단계별 완료 상태와 배포·운영 증거
- [authored-js-baseline.json](./authored-js-baseline.json): 파일 단위의 기계 판독 가능
  역사적 기준선과 현재 remaining/retired 상태
- [`scripts/check-authored-js-inventory.mts`](../../scripts/check-authored-js-inventory.mts):
  새 JavaScript 경로와 기준선 역행을 영구 차단하는 zero-JavaScript guard
- [`scripts/check-typescript-declaration-ownership.mts`](../../scripts/check-typescript-declaration-ownership.mts):
  Wrangler 생성 타입과 실제 외부 declaration을 exact allowlist로 고정하고 native
  companion 재도입을 차단하는 ownership guard
- [`scripts/check-typescript-project-coverage.mts`](../../scripts/check-typescript-project-coverage.mts):
  모든 tracked 및 새 unignored TS·TSX·MTS·CTS가 19개 strict `tsc` project 중 하나에 실제로
  포함되는지 검증하는 project-coverage guard

전환 중 사용한 JavaScript strict-diagnostic ratchet과 수기 companion declaration은
remaining source가 0이 된 Phase 10에서 제거했다. 현재 타입 안전성은 각 런타임의 strict
TypeScript project, production type-escape guard와 전체 CI가 직접 강제한다.

현재 인벤토리가 충돌할 때는 `authored-js-baseline.json`의 실제 파일 상태와
`STATUS.md`를 우선한다. `ROADMAP.md`는 완료된 전환의 역사 기록이다. 문서가 코드와
어긋난 것을 발견한 PR은 같은 PR에서 상태를 바로잡는다.

## 기준선 갱신 규약

JavaScript 계열 파일을 TypeScript로 전환하는 PR은 다음 변경을 원자적으로 수행한다.

1. 원래 파일을 제거하고 TypeScript 구현을 추가한다.
2. manifest에서 원래 경로의 `status`를 `remaining`에서 `retired`로만 바꾼다.
3. `STATUS.md`의 현재 수치와 단계 상태를 갱신한다.
4. 해당 런타임의 타입 검사, 테스트, 번들 dry-run을 통과시킨다.

`retired → remaining`, 기존 항목 수정, 새 JavaScript 계열 경로 추가는 허용하지 않는다.
파일의 구현 줄 수는 정상적인 편집으로 변할 수 있으므로 `baselineLines`는 역사적
스냅샷이며 현재 코드 크기 제한으로 사용하지 않는다.

## 변경의 단위

전환 PR에는 언어 전환과 그에 직접 필요한 타입·경로·테스트 수정만 포함한다. 기능,
프로토콜, binding, migration, compatibility date, 캐시 정책 변경은 별도 PR로 분리한다.
큰 Worker는 줄 수만 줄이기 위해 분해하지 않는다. 동일한 lifecycle, authority 또는
원자적 mutation을 소유하는 코드는 함께 남기는 것이 기본값이다.
