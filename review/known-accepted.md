# Known & Accepted Issues — 재보고 방지 목록

fix15 전수조사 기준. 다음 감사 시 이 파일을 참조하여 중복 보고를 방지할 것.

---

## 1. `cleanupOPFSInWorker` bus listener leak — `opfs.ts:95-119`

**상태**: ACCEPTED (발생 조건 극히 드뭄)
**문제**: 동일 파일에 대해 cleanup을 연속 호출하면 `setManagedTimer`가 이전 타이머를 대체하지만,
이전 `bus.on('opfs:cleanup-complete')` 리스너의 `unsub` 클로저가 orphan됨.
**이유**: 동일 파일 연속 cleanup은 실사용에서 발생하지 않음.
세션 종료 시 리스너가 자연 정리.

---

## 업데이트 이력
- 2026-03-13: fix15 감사 후 작성 — 8항목 중 7항목 전부 수정, 1건만 잔존
