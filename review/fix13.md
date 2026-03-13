# fix13 — 13차 전수조사

## 감사 범위
- **전체 소스**: `src/` 하위 55+ 파일 전수 읽기
- **도메인**: Audio(3), Core(8), Network(8), Player(7), Storage(7), YouTube(6), UI(14), App(1)

## 감사 결과 요약
12차까지 ~140건 수정 후 코드베이스 매우 안정적. **M3 + L5 = 8 인스턴스** 발견.

---

## 발견 항목

### M-1. `setPreamp()` NaN 가드 누락 — `effects.ts:288`

**심각도**: MEDIUM
**문제**: `Number(valDb)` → `Math.max/min` → `Math.pow` 체인에서 NaN 입력 시
NaN이 state 저장 + Tone.js preamp 노드로 전파 → 오디오 무음.
같은 파일의 `setReverbParam`, `updateSubFreq`에는 가드 있음.
**수정**: `if (!Number.isFinite(db)) return;` 추가.

### M-2. `setStereoWidth()` NaN 가드 누락 — `effects.ts:297`

**심각도**: MEDIUM
**문제**: NaN 입력 시 `NaN / 100` → `Math.max(0, Math.min(2, NaN))` = NaN →
widener + preamp 두 노드에 NaN 전파 (보상 gain 계산도 NaN 감염).
**수정**: `Number(val)` + `if (!Number.isFinite(v)) return;` 추가.

### M-3. `setVirtualBass()` NaN 가드 누락 — `effects.ts:308`

**심각도**: MEDIUM
**문제**: M-2와 동일 패턴. NaN → virtual bass gain 노드 감염.
**수정**: `Number(val)` + `if (!Number.isFinite(v)) return;` 추가.

### L-1. `playlist.ts` handleRequestSetting — reverb 파라미터 NaN 가드 누락 (4건)

**심각도**: LOW (defense-in-depth)
**파일**: `src/player/playlist.ts` lines 545-568
**문제**: `REVERB_DECAY`, `REVERB_PREDELAY`, `REVERB_LOWCUT`, `REVERB_HIGHCUT` 케이스에
`Number()` 변환 후 `Number.isFinite()` 가드 없이 `setReverbParam()` + `broadcast()` 호출.
같은 함수 내 `REVERB`(mix) 케이스(line 535)에는 가드가 있어 패턴 불일치.
**영향**: `setReverbParam` 내부에 자체 클램프가 있어 실질적 NaN 전파 위험 낮음.
그러나 불필요한 broadcast 방지 + 패턴 일관성을 위해 추가.
**수정**: 4개 케이스에 `if (!Number.isFinite(v)) break;` 추가.

### L-2. Non-OP Guest stereo width 변경 시 토스트 누락 — `effects.ts:388`

**심각도**: LOW (UX 일관성)
**문제**: reverb/vbass는 `_broadcastOrRequestSetting`을 사용하여 non-OP Guest에게
`toast.operator_required` 표시. 하지만 stereo width는 인라인 코드로
non-OP 분기에 토스트 없음 → 설정이 무시되는 이유를 사용자가 모름.
**수정**: `else if (!isOperator)` 분기에 토스트 추가 (`_broadcastOrRequestSetting` 패턴 동일).

---

## 통계
| 심각도 | 건수 |
|--------|------|
| CRITICAL | 0 |
| HIGH | 0 |
| MEDIUM | 3 |
| LOW | 2 패턴 (5 인스턴스) |
| **합계** | **8 인스턴스** |
