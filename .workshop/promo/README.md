# MUSIXQUARE 최종 광고

2026-09-10에 확정한 한국어·영어, 가로·세로 광고 4종이다. 멘트는 모두
세미볼드(600)이며, 35.25초, FHD, 60fps다.
첫 프레임과 마지막 프레임은 전체 흰색이다.

| 구분 | 명령 ID | 최종 영상 | 해상도 |
| --- | --- | --- | --- |
| 영어 가로 | `landscape-en` | `output/MUSIXQUARE_EN_Landscape_Semibold_16x9.mp4` | 1920 × 1080 |
| 한국어 가로 | `landscape-ko` | `output/MUSIXQUARE_KO_Landscape_Semibold_16x9.mp4` | 1920 × 1080 |
| 영어 세로 | `portrait-en` | `output/MUSIXQUARE_EN_Portrait_Semibold_9x16.mp4` | 1080 × 1920 |
| 한국어 세로 | `portrait-ko` | `output/MUSIXQUARE_KO_Portrait_Semibold_9x16.mp4` | 1080 × 1920 |

가로 영상은 좌상단에 멘트를 왼쪽 정렬하고, 우상단에 크기를 줄인 로고와
`musixquare.com`을 배치한다. 로고·주소는 처음과 끝을 제외한 중간 장면 전환에도
계속 보인다. 세로 영상은 확대·블러와 흰색 상단 페이드를 포함한다.
한국어 영상의 인앱 UI는 실제 앱의 한국어 표기를 사용하며, 기기·채팅 이름은
앱 기본값인 `HOST`, `Peer 1·2·3`을 유지한다.

네 영상 모두 로고의 블러 강도 변화를 부드럽게 연결한 수정과 기존 색감을
복원한 JPEG 인코딩 경로를 사용한다.
곡은 **Whispers of Stillness — Monument Music**이며, 25.5초부터 광고 화면의
Arena 리버브와 처리된 음악이 함께 전환된다. 모든 초대 코드는 `197625`다.

## 폴더 구성

- `output/`: 확정된 MP4 원본. 새로 렌더링해도 이 파일들은 덮어쓰지 않는다.
- `source/landscape-semibold-en/`, `source/landscape-semibold-ko/`: 가로 최종본의 장면, 실제 앱 UI 캡처와 음원.
- `source/portrait-semibold-en/`, `source/portrait-semibold-ko/`: 세로 최종본의 재생 자료.
- `output/archive/2026-09-10-before-semibold/`: 이전 영상·소스·제작 도구와 교체 전 패키지 문서 보관.
- `manifest.json`: 현재 최종본 4종의 규격·SHA-256 및 소스 파일의 크기·SHA-256.
- `render.ts`: 네 최종본에 공통으로 사용하는 렌더·미리보기·무결성 검사 명령.

현재 최종본은 `manifest.json`의 네 항목으로 지정한다. `source/`의 현재 재생 자료는
위 네 폴더이며, `output/` 바로 아래의 MP4도 네 최종본이다. 이전 버전은
`output/archive/`에 보관하며, 렌더·검사 명령은 현재 네 항목만 사용한다.
각 최종본의 소스 목록에는 재생 자산, 제작 메타데이터와 라이선스를 함께 기록한다.
장면의 상대경로는 그대로 유지하므로 이 폴더를 옮겨도 이전 `scratch` 폴더나
특정 사용자의 바탕화면 경로가 필요하지 않다.

## 사용

저장소의 고정 Node/npm 환경과 `npm ci`, Chrome, PATH에 등록된 FFmpeg/ffprobe가
필요하다. 실행 파일 경로는 `FFMPEG_PATH`, `FFPROBE_PATH`로 지정할 수 있다.

```sh
# 최종본 목록과 명령 안내
npm run promo:render

# 확정 영상과 소스 파일의 SHA-256 및 영상 규격 검사
npm run promo:render -- --verify

# 네 최종본의 주요 장면을 PNG로 확인
npm run promo:render -- --preview

# 선택한 최종본 다시 렌더링
npm run promo:render -- --variant landscape-en
npm run promo:render -- --variant landscape-ko
npm run promo:render -- --variant portrait-en
npm run promo:render -- --variant portrait-ko
```

미리보기는 `output/previews/`, 새 렌더는 `output/renders/`에 생성된다.
모두 다시 렌더링하려면 `--variant all`을 사용한다.
색상은 승인된 **JPEG 98 → MJPEG BT.601 → BT.709 limited YUV420P** 경로를 유지한다.
이를 PNG 입력으로 바꾸면 회색의 실제 RGB 값도 달라지므로 별도 색상 검증이 필요하다.

## GitHub 반영 범위

`README.md`, `manifest.json`, `render.ts`는 Git으로
관리한다. `source/`와 `output/`은 로컬 제작 자료로 Git에서 제외한다. 다른 컴퓨터로
작업물을 옮길 때는 **이 두 폴더도 함께 복사**해야 한다. Git clone만으로 영상이나
렌더 자산이 내려오지는 않는다.

이 폴더는 실제 사이트의 Vite 배포 입력이 아니다. 광고 도구 정리는 GitHub PR 병합으로
반영하며, Cloudflare 앱 배포나 제품 버전 변경이 필요하지 않다. 음원은 사용자가 광고에
사용하도록 제공한 파일이고, 원본 음원은 로컬 제작 자료 안에만 보관한다.
