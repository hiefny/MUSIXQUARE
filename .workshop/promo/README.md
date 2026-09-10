# MUSIXQUARE 최종 광고

2026-09-11에 확정한 한국어·영어, 가로·세로 광고 4종이다. 모두 **4K, 60fps,
35.25초**이며 첫 프레임과 마지막 프레임은 전체 흰색이다.

| 구분        | 명령 ID        | 최종 영상                                    | 해상도      |
| ----------- | -------------- | -------------------------------------------- | ----------- |
| 영어 가로   | `landscape-en` | `output/MUSIXQUARE_EN_Landscape_4K_16x9.mp4` | 3840 × 2160 |
| 한국어 가로 | `landscape-ko` | `output/MUSIXQUARE_KO_Landscape_4K_16x9.mp4` | 3840 × 2160 |
| 영어 세로   | `portrait-en`  | `output/MUSIXQUARE_EN_Portrait_4K_9x16.mp4`  | 2160 × 3840 |
| 한국어 세로 | `portrait-ko`  | `output/MUSIXQUARE_KO_Portrait_4K_9x16.mp4`  | 2160 × 3840 |

멘트는 세미볼드(600), 앱의 밝은 테마 `TEXT MAIN` 색상인 `#303540`이다.
가로 영상은 좌상단 멘트와 우상단 로고·`musixquare.com`을 사용하며, 우측 브랜드는
처음과 끝을 제외한 중간 장면 전환에도 계속 보인다. 세로 영상은 기존 중앙 멘트,
확대·블러와 흰색 상단 페이드를 유지한다.

인앱 UI는 실제 앱을 고해상도로 캡처한 자료다. 한국어 영상의 UI와 채팅도 실제 앱의
한국어 표기를 따르며, 기기·채팅 이름은 `HOST`, `Peer 1·2·3`을 유지한다.
데스크탑 화면은 5760 × 3600으로 캡처했고, 축소 필터를 조정해 작은 글자의 선명도를
보존한다. 비주얼라이저는 실제 앱의 음악 분석 상태와 그리기 함수를 사용한다.

블러는 초점 영역 밖에서 점차 강해진다. 강한 블러를 작은 격자에서 확대하던 방식을
교체했고, 약한 블러는 출력 해상도에서, 큰 커널은 최대 2:1 축소까지만 계산한다.
색상을 일정하게 유지하는 Gaussian 계산으로 격자무늬와 전환 경계를 개선했다.
승인된 UI 배치, 등장·줌·스크롤·기울기 애니메이션과 타이밍은 그대로다.

음악은 **Whispers of Stillness — Monument Music**이다. 25.5초부터 광고 화면의
Arena 리버브와 처리된 음악이 함께 전환되며, 모든 초대 코드는 `197625`다.

## 폴더 구성

- `output/`: 현재 확정된 MP4 4개. 새 렌더는 이 파일들을 덮어쓰지 않는다.
- `source/landscape-4k-en/`, `source/landscape-4k-ko/`: 가로 최종본의 장면, 실제 앱 UI 캡처, 음원과 라이선스.
- `source/portrait-4k-en/`, `source/portrait-4k-ko/`: 세로 최종본의 재생 자료.
- `output/verification/2026-09-11-4k-final/`: 승인 영상의 규격·전체 디코딩·음원·흰색 시작/끝 검사, 블러 비교와 검수 기록.
- `output/archive/2026-09-11-before-4k-final/`: 이전 FHD 최종본과 소스, 4K·21:9·시간 단축 등 시안, 교체 전 문서·목록·도구.
- `manifest.json`: 현재 최종본 4종의 규격·SHA-256, 전체 소스 파일의 크기·SHA-256, 렌더 설정.
- `render.ts`: 공통 렌더·미리보기·무결성 검사 명령.

현재 최종본은 `manifest.json`의 네 항목으로 지정한다. `source/` 바로 아래에는
위 네 소스 폴더, `output/` 바로 아래에는 네 최종 MP4만 둔다. 이전 자료는 삭제하지 않고
`output/archive/`로 모았으며 현재 렌더 명령에서 사용하지 않는다.

재생에 필요한 파일은 각 소스 폴더 안의 상대경로로 연결된다. 제작 이력 JSON에 남은
원래 작업 경로는 참고 기록이며 렌더에 필요하지 않다. 이전 폴더를 별도로 유지하지 않아도
현재 소스와 공통 렌더러만으로 재생할 수 있다.

## 사용

저장소의 고정 Node/npm 환경과 `npm ci`, Chrome, PATH에 등록된 FFmpeg/ffprobe가
필요하다. 실행 파일 경로는 `FFMPEG_PATH`, `FFPROBE_PATH`로 지정할 수 있다.

```sh
# 최종본 목록과 명령 안내
npm run promo:render

# 네 확정 영상과 모든 소스의 SHA-256 및 영상 규격 검사
npm run promo:render -- --verify

# 주요 장면을 PNG로 확인
npm run promo:render -- --preview

# 선택한 최종본 다시 렌더링
npm run promo:render -- --variant landscape-en
npm run promo:render -- --variant landscape-ko
npm run promo:render -- --variant portrait-en
npm run promo:render -- --variant portrait-ko
```

미리보기는 `output/previews/`, 새 렌더는 `output/renders/`에 생성된다.
모두 다시 렌더링하려면 `--variant all`을 사용한다.
승인된 **JPEG 98 → MJPEG BT.601 → BT.709 limited YUV420P**, x264 medium CRF 16,
AAC 256k stereo 48kHz 설정을 유지한다. 다른 입력·색 변환 경로를 사용하려면 실제
인코딩 결과의 색상을 다시 비교해야 한다.

## GitHub 반영 범위

`README.md`, `manifest.json`, `render.ts`는 Git으로 관리한다. `source/`와 `output/`은
로컬 제작 자료로 Git에서 제외한다. 다른 컴퓨터로 옮길 때는 **이 두 폴더도 함께 복사**해야
한다. Git clone만으로 영상이나 렌더 자산이 내려오지는 않는다.

이 폴더는 실제 사이트의 Vite 배포 입력이 아니다. 광고 도구와 최종본 목록은 GitHub PR
병합으로 반영하며, Cloudflare 앱 배포나 제품·캐시 버전 변경은 필요하지 않다.
음원은 사용자가 광고에 사용하도록 제공한 파일이고, 원본 음원은 로컬 제작 자료에 보관한다.
