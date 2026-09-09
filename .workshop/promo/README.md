# MUSIXQUARE 최종 광고

2026-09-10에 확정한 영어 광고 3종이다. 모두 35.25초, FHD, 60fps이며
첫 프레임과 마지막 프레임은 전체 흰색이다.

| 구분 | 최종 영상 | 해상도 |
| --- | --- | --- |
| 세로 기본 최종본 | `output/MUSIXQUARE_EN_Final_9x16.mp4` | 1080 × 1920 |
| 가로 확대·블러 최종본 | `output/MUSIXQUARE_EN_Landscape_16x9.mp4` | 1920 × 1080 |
| 세로 확대·블러 최종본 | `output/MUSIXQUARE_EN_Portrait_Focus_9x16.mp4` | 1080 × 1920 |

확대·블러 버전은 로고의 블러 강도 변화를 부드럽게 연결한 수정과 기존 색감을
복원한 JPEG 인코딩 경로를 사용한다. 세로 확대 버전의 흰색 상단 페이드도 포함한다.
곡은 **Whispers of Stillness — Monument Music**이며, 25.5초부터 광고 화면의
Arena 리버브와 처리된 음악이 함께 전환된다. 모든 초대 코드는 `197625`다.

## 폴더 구성

- `output/`: 확정된 MP4 원본. 새로 렌더링해도 이 파일들은 덮어쓰지 않는다.
- `source/portrait-final/`: 세로 기본 최종본의 장면, 실제 앱 UI 캡처와 음원.
- `source/landscape-calm/`: 가로 확대·블러 최종본의 재생 자료.
- `source/portrait-focus/`: 세로 확대·블러 최종본의 재생 자료.
- `manifest.json`: 최종 영상 규격·SHA-256 및 모든 소스 파일의 크기·SHA-256.
- `render.ts`: 세 최종본에 공통으로 사용하는 렌더·미리보기·무결성 검사 명령.

`source/`에는 현재 장면에 필요한 파일과 원본 UI 참고 이미지, 사용한 라이브러리의
라이선스만 있다. 이전 광고 장면, 실패한 수정본, 중간 렌더, 옛 캡처 스크립트는
이 패키지에 포함하지 않는다. 장면의 상대경로는 그대로 유지하므로 이 폴더를
옮겨도 이전 `scratch` 폴더나 특정 사용자의 바탕화면 경로가 필요하지 않다.

## 사용

저장소의 고정 Node/npm 환경과 `npm ci`, Chrome, PATH에 등록된 FFmpeg/ffprobe가
필요하다. 실행 파일 경로는 `FFMPEG_PATH`, `FFPROBE_PATH`로 지정할 수 있다.

```sh
# 최종본 목록과 명령 안내
npm run promo:render

# 확정 영상과 소스 파일의 SHA-256 및 영상 규격 검사
npm run promo:render -- --verify

# 세 최종본의 주요 장면을 PNG로 확인
npm run promo:render -- --preview

# 선택한 최종본 다시 렌더링
npm run promo:render -- --variant landscape
npm run promo:render -- --variant portrait-focus
npm run promo:render -- --variant portrait
```

미리보기는 `output/previews/`, 새 렌더는 `output/renders/`에 생성된다.
모두 다시 렌더링하려면 `--variant all`을 사용한다.
색상은 승인된 **JPEG 98 → MJPEG BT.601 → BT.709 limited YUV420P** 경로를 유지한다.
이를 PNG 입력으로 바꾸면 회색의 실제 RGB 값도 달라지므로 별도 색상 검증이 필요하다.

## GitHub 반영 범위

`README.md`, `manifest.json`, `render.ts`와 폐기한 옛 광고 도구의 연결 정리는 Git으로
관리한다. `source/`와 `output/`은 로컬 제작 자료로 Git에서 제외한다. 다른 컴퓨터로
작업물을 옮길 때는 **이 두 폴더도 함께 복사**해야 한다. Git clone만으로 영상이나
렌더 자산이 내려오지는 않는다.

이 폴더는 실제 사이트의 Vite 배포 입력이 아니다. 광고 도구 정리는 GitHub PR 병합으로
반영하며, Cloudflare 앱 배포나 제품 버전 변경이 필요하지 않다. 음원은 사용자가 광고에
사용하도록 제공한 파일이고, 원본 음원은 로컬 제작 자료 안에만 보관한다.
