# 화면 보호기 시계 전용·도움말 진입·베이스 반응 (2026-10-21)

- Status: 브랜치 구현·로컬 검증 기록이다. 버전·서비스 워커 캐시는 올리지 않았고 배포하지 않았다. 배포 결과의
  정본은 [릴리스 기록](../release-record.md)과 [릴리스 이력](../release-history.md)이다.
- 계기: 오너 요청(2026-10-21).
- 검증한 코드: `30c3dd5e`(브랜치 `agent/screensaver-help`, 기준 main `e1ed16d6`).

## 변경

- 도움말 탭: "앱 체험하기"가 초대 링크 복사 버튼과 같은 회색 모양(`neutral-action-btn`, 초대 링크 버튼과 선택자
  공유)이 됐다. 그 아래에 기존 파란 버튼 모양의 "화면 보호기 켜기"(`screensaver.turn_on`, 42개 언어)를 두었다.
  누르면 `/screensaver`와 같은 `ui:open-screensaver` 경로로 열린다(전체 화면 요청은 클릭 안에서, 유튜브 중에는
  기존 안내 토스트). PRO 방에서는 체험 버튼만 기존대로 숨는다.
- 화면 보호기: 시계·배경·그레인·반짝이만 남겼다. 날짜·날씨·대기질·달 장면, 장면 순환, `weatherCanvas`·다시 시도
  버튼·출처 링크와 CSS, Open-Meteo 요청, 위치 요청, 정보 장면만 쓰던 합성기 글자 경로, SunCalc 고지가 빠졌다.
  시계 글꼴·타이포그래피는 손대지 않았다. 런타임은 약 230 KB에서 130,373 bytes가 됐다.
- 권한: 앱 문서와 화면 보호기 문서 모두 `geolocation=()`, 화면 보호기 CSP `connect-src 'self'`. iframe `allow`는
  `fullscreen 'self'`만 남았다. 개인정보처리방침의 화면 보호기 문단을 실제 동작에 맞게 고쳤다(시행일은 그대로,
  오너 판단 사항).
- 닫기: 컨트롤 밖 더블클릭(마우스는 `dblclick`), 터치는 320 ms·32 px 안의 두 번 탭이면 기존 닫기
  (`postToHost('close')`)를 쓴다. 한 번 탭은 컨트롤만 보인다. 문서 전체에 앱과 같은 `touch-action: manipulation`과
  iOS 핀치 차단을 넣었다.
- 베이스 반응: 호스트가 재생 탭 시각화와 같은 분석기·같은 저음 구간(`src/audio/bass-level.ts`, 시각화도 이 함수를
  쓰도록 정리)을 30 Hz 이하로 읽고, 화면 보호기 iframe에 `brightness()` 필터를 최대 6%까지 올린다(상승 60 ms,
  하강 450 ms, 0.1% 미만이면 필터 없음). 메시지를 주고받지 않아 화면 보호기 문서는 바뀌지 않는다. 동작 줄이기,
  유튜브(교차 출처라 분석 불가), 일시정지·무음, 숨은 탭에서는 꺼진다. 코드는 지연 로드되는 화면 보호기 묶음에만
  있다.
- 예전 장면 배경 이미지는 그대로 둔다. 배포 직후 이미 열려 있는 이전 화면 보호기가 요청할 수 있어서다(#375 리뷰
  선례). 새 런타임과 매니페스트는 참조하지 않는다. 삭제는 후속 판단이다.

## 번역

| 언어    | 문구                          | 언어    | 문구                           |
| ------- | ----------------------------- | ------- | ------------------------------ |
| ko      | 화면 보호기 켜기              | ja      | スクリーンセーバーをオンにする |
| en      | Turn on screensaver           | kn      | ಸ್ಕ್ರೀನ್‌ಸೇವರ್ ಆನ್ ಮಾಡಿ        |
| ar      | تشغيل شاشة التوقف             | ml      | സ്ക്രീൻസേവർ ഓണാക്കുക           |
| bg      | Пусни скрийнсейвъра           | mr      | स्क्रीनसेव्हर सुरू करा         |
| bn      | স্ক্রিনসেভার চালু করুন        | ms      | Hidupkan penyelamat skrin      |
| cs      | Zapnout spořič obrazovky      | nb      | Slå på skjermsparer            |
| da      | Slå pauseskærm til            | nl      | Schermbeveiliging aanzetten    |
| de      | Bildschirmschoner einschalten | pa      | ਸਕ੍ਰੀਨਸੇਵਰ ਚਾਲੂ ਕਰੋ            |
| el      | Έναρξη προφύλαξης οθόνης      | pl      | Włącz wygaszacz ekranu         |
| es      | Activar salvapantallas        | pt-br   | Ativar protetor de tela        |
| fa      | روشن کردن محافظ صفحه          | ro      | Pornește economizorul de ecran |
| fi      | Käynnistä näytönsäästäjä      | ru      | Включить заставку              |
| fil     | I-on ang screensaver          | sv      | Slå på skärmsläckaren          |
| fr      | Activer l’économiseur d’écran | ta      | திரைக்காப்பானை இயக்கு          |
| gu      | સ્ક્રીનસેવર ચાલુ કરો          | te      | స్క్రీన్‌సేవర్ ఆన్ చేయండి      |
| he      | הפעלת שומר המסך               | th      | เปิดโปรแกรมรักษาหน้าจอ         |
| hi      | स्क्रीनसेवर चालू करें         | tr      | Ekran koruyucuyu aç            |
| hu      | Képernyőkímélő bekapcsolása   | uk      | Увімкнути заставку             |
| id      | Aktifkan screensaver          | ur      | اسکرین سیور آن کریں            |
| it      | Attiva salvaschermo           | vi      | Bật trình bảo vệ màn hình      |
| zh-hans | 开启屏幕保护程序              | zh-hant | 開啟螢幕保護程式               |

각 언어의 기존 화면 보호기 단어(`chat.cmd_d_screensaver`, `toast.screensaver_youtube`)를 그대로 썼다. 긴 문구는
버튼 안에서 줄바꿈된다.

## 검증 (Windows, Node 24.20.0, Playwright Chromium)

- 통과: `typecheck`, `lint`, `format:check`, `guard:bus-pairing`, `guard:dead-exports`, `guard:import-graph`, 전체
  Vitest 601 파일·13,482 테스트(`--maxWorkers=6`).
- `build:checked`는 버전을 올리지 않아 `guard:sw-cache-version`에서만 실패했다(의도). 나머지 단계(`build`,
  `guard:initial-transfer-budget` 포함 12개)를 따로 돌려 모두 통과했다. 초기 전송 eager total 553.0 KiB gzip.
- e2e `screensaver.test.ts` 17개 통과: 도움말 버튼으로 열기(초대 링크 버튼과 계산된 모양 일치), 60초 동안 시계만
  유지, 위치 요청 0회, Open-Meteo·장면 이미지 요청 0건, 더블클릭 닫기·한 번 클릭과 느린 두 번 클릭 유지, 터치
  두 번 탭 닫기·떨어진 두 탭 유지·확대 배율 1 유지, 합성 저음 펄스로 밝기 최고 1.03 초과 1.06 이하·한 프레임
  점프 없음·하강 후 필터 제거·동작 줄이기에서 필터 없음, 화면 크기 변경 시 배경 교차 전환·실패 시 이전 배경 유지.
  같은 빌드에서 `back-navigation`·`app-touch-policy`·`component-cascade`와 함께 36개 통과(실패·건너뜀 0).
- 도움말 스크린샷 390×844·1440×900 라이트·다크를 눈으로 확인했다. 두 버튼 폭·위치가 같다.
- 한계: 실기기(iOS Safari·Android)와 실제 음악의 체감 밝기는 확인하지 않았다. 베이스 검증은 분석기 값을 합성한
  것이다. e2e는 Google Sans를 막아 대체 글꼴로 그린다. WebKit e2e와 전체 e2e 묶음은 돌리지 않았다.
