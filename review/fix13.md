# fix13 — 13차 전수조사

## 감사 범위
- **전체 소스**: `src/` 하위 55+ 파일 전수 읽기
- **도메인**: Audio(3), Core(8), Network(8), Player(7), Storage(7), YouTube(6), UI(14), App(1)

## 감사 결과 요약
12차까지 ~140건 수정 후 코드베이스 매우 안정적. **1 패턴(4 인스턴스)** 발견.

---

## 발견 항목

### L-1. `playlist.ts` handleRequestSetting — reverb 파라미터 NaN 가드 누락 (4건)

**심각도**: LOW (defense-in-depth)
**파일**: `src/player/playlist.ts` lines 545-568
**문제**: `REVERB_DECAY`, `REVERB_PREDELAY`, `REVERB_LOWCUT`, `REVERB_HIGHCUT` 케이스에
`Number()` 변환 후 `Number.isFinite()` 가드 없이 `setReverbParam()` + `broadcast()` 호출.
같은 함수 내 `REVERB`(mix) 케이스(line 535)에는 가드가 있어 패턴 불일치.

**영향**: `setReverbParam` 내부에 자체 클램프가 있고, 수신측에서도 재검증하므로
실질적 NaN 전파 위험은 낮음. 그러나 불필요한 broadcast와 패턴 일관성을 위해 추가.

**수정**: 4개 케이스에 `if (!Number.isFinite(v)) break;` 추가 (REVERB mix 패턴 동일).

---

## 통계
| 심각도 | 건수 |
|--------|------|
| CRITICAL | 0 |
| HIGH | 0 |
| MEDIUM | 0 |
| LOW | 1 패턴 (4 인스턴스) |
| **합계** | **4 인스턴스** |
