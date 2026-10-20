# 본문 건너뛰기 링크 번역 (2026-10-20)

- Status: 8.11.31 번역 수정·검증 기록이다. 배포 결과의 정본은 [릴리스 기록](../release-record.md)과
  [릴리스 이력](../release-history.md)이다.
- 계기: 오너 요청(2026-10-20). 앱 맨 위의 키보드용 건너뛰기 링크(`.skip-link`)가 `index.html`에 영어
  "Skip to content"로 고정돼 42개 언어 모두 영어로 보였다. 오너는 기계 번역 대신 각 언어에서 실제로 쓰는 사례를
  쓰자고 했다.
- 커밋: `3eba614f`(번역 키·42개 언어·테스트·8.11.31), `2cd4770c`(서비스 워커 캐시 v740).

## 변경

- 새 키 `common.skip_to_content`를 42개 언어 사전에 넣고, `index.html`의 링크에 `data-i18n`으로 연결했다.
  빌드 때 만드는 언어별 문서와 실행 중 번역 모두 이 키를 쓴다. 영어 문구, 링크 주소, 동작, 스타일은 그대로다.
- `html-fallback-copy.test.ts`가 링크와 키의 연결을 고정한다. 기존 검사가 영어 기본 문구와 사전 값이 같은지도
  확인한다.

## 번역 출처

원문이 우리와 같은 "Skip to content"인 WordPress 커뮤니티 번역을 썼다. 언어별 번역팀이 검수해 공개한 번역이다.
Twenty Twenty-One 테마 번역을 먼저 쓰고, 테마 번역이 없는 11개 언어는 WordPress 본체(`wp/dev`) 번역을 썼다.
같은 용도인 위키백과 Vector 스킨의 "Jump to content" 번역을 비교용으로 함께 적는다. 적용 값 41개는 내려받은 번역
파일과 글자 단위로 대조했다(불일치 0).

| 언어    | 적용 문구                   | 출처           | 위키백과 "Jump to content" |
| ------- | --------------------------- | -------------- | -------------------------- |
| ar      | التخطي إلى المحتوى          | WordPress 테마 | انتقل إلى المحتوى          |
| bg      | Напред към съдържанието     | WordPress 테마 | Направо към съдържанието   |
| bn      | এড়িয়ে কনটেন্টে যান        | WordPress 본체 | বিষয়বস্তুতে চলুন          |
| cs      | Přejít k obsahu             | WordPress 테마 | Přeskočit na obsah         |
| da      | Fortsæt til indhold         | WordPress 테마 | Spring til indhold         |
| de      | Zum Inhalt springen         | WordPress 테마 | 같음                       |
| el      | Μετάβαση σε περιεχόμενο     | WordPress 테마 | Μετάβαση στο περιεχόμενο   |
| es      | Saltar al contenido         | WordPress 본체 | Ir al contenido            |
| fa      | پرش به محتوا                | WordPress 테마 | 같음                       |
| fi      | Siirry sisältöön            | WordPress 테마 | 같음                       |
| fil     | Lumaktaw patungo sa content | WordPress 본체 | Pumunta sa nilalaman       |
| fr      | Aller au contenu            | WordPress 본체 | 같음                       |
| gu      | કંટેન્ટ પર જાઓ              | WordPress 테마 | લખાણ પર જાઓ                |
| he      | דילוג לתוכן                 | WordPress 테마 | לדלג לתוכן                 |
| hi      | सामग्री पर जाएं             | WordPress 테마 | सामग्री पर जाएँ            |
| hu      | Ugrás a tartalomhoz         | WordPress 테마 | 같음                       |
| id      | Lewati ke konten            | WordPress 테마 | Lompat ke isi              |
| it      | Salta al contenuto          | WordPress 테마 | Vai al contenuto           |
| ja      | コンテンツへスキップ        | WordPress 테마 | コンテンツにスキップ       |
| kn      | ವಿಷಯಕ್ಕೆ ತೆರಳಿ              | WordPress 본체 | ವಿಷಯಕ್ಕೆ ಹೋಗು              |
| ko      | 콘텐츠로 바로가기           | WordPress 테마 | 본문으로 이동              |
| ml      | ഉള്ളടക്കത്തിലേക്ക് നീങ്ങുക  | WordPress 테마 | ഉള്ളടക്കത്തിലേക്ക് പോവുക   |
| mr      | सामुग्रीवर जा               | WordPress 본체 | 없음                       |
| ms      | Langkau ke kandungan        | WordPress 테마 | Pergi ke kandungan         |
| nb      | Gå til innhold              | WordPress 테마 | Hopp til innhold           |
| nl      | Ga naar de inhoud           | WordPress 테마 | Naar inhoud springen       |
| pa      | ਸਿੱਧਾ ਸਮੱਗਰੀ 'ਤੇ ਜਾਓ        | WordPress 본체 | ਸਮੱਗਰੀ 'ਤੇ ਜਾਓ             |
| pl      | Przejdź do treści           | WordPress 테마 | Przejdź do zawartości      |
| pt-br   | Pular para o conteúdo       | WordPress 테마 | Ir para o conteúdo         |
| ro      | Sari la conținut            | WordPress 테마 | 같음                       |
| ru      | Перейти к содержимому       | WordPress 테마 | Перейти к содержанию       |
| sv      | Hoppa till innehåll         | WordPress 테마 | Hoppa till innehållet      |
| ta      | உள்ளடக்கத்திற்கு செல்க      | WordPress 테마 | உள்ளடக்கத்துக்குச் செல்    |
| te      | విషయానికి వెళ్ళండి          | WordPress 본체 | 없음                       |
| th      | ข้ามไปยังเนื้อหา            | WordPress 본체 | ข้ามไปเนื้อหา              |
| tr      | İçeriğe geç                 | WordPress 테마 | İçeriğe atla               |
| uk      | Перейти до вмісту           | WordPress 테마 | 같음                       |
| ur      | چھوڑیں مواد پر جائیں        | WordPress 본체 | مندرجات کا رخ کریں         |
| vi      | Chuyển đến phần nội dung    | WordPress 본체 | Bước tới nội dung          |
| zh-hans | 跳至内容                    | WordPress 테마 | 跳转到内容                 |
| zh-hant | 跳至主要內容                | WordPress 테마 | 跳至內容                   |

## 검증

- 로컬 Windows, Node 24.20.0 / npm 12.0.2, 커밋 `2cd4770c`: `npm run typecheck`·린트·포맷·committed
  `build:checked`(release identity 8.11.31 / v740, sw-cache-version 통과) 통과, unit 600 files / 13,477 pass /
  0 fail / 0 skip. 번역 테스트 29 files / 392 pass.
- 빌드 결과물 `dist/<언어>/index.html` 42개에서 링크 글자가 각 언어 사전 값과 같은지 확인했다.
- 로컬 결과는 exact-main CI 후보를 대신하지 않는다.

## 한계

- 원어민 검토는 하지 않았다. WordPress 번역을 그대로 옮겼다. 본체 번역에서 가져온 일부 언어(bn, ur 등)는 위키백과
  번역과 어순과 단어가 다르다. 사용자 제보가 오면 그 언어부터 다시 본다.
- 링크는 키보드 포커스를 받을 때만 보이는 자동 폭 요소다. 긴 번역이 좁은 화면에서 어떻게 보이는지 실제 기기나
  브라우저로 확인하지 않았다.
