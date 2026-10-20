# Playlist delete mode with an Undo window — 2026-10-20

## Request

The owner asked for a new multi-select deletion mode in the playlist. The old
mode floated one blue pill with icon buttons (select all, delete with a count
badge, cancel) and deleted at once.

## Change

- **Header.** While rows are selected, the "Playlist" title reads
  `playlist.selected_count` ("2 selected", Korean "2개 선택됨"), keeping the
  title's size and weight. Repeat, shuffle and add media are hidden and one
  blue text button sits on the right: "Select all (N)" with the playlist
  total until every visible row is selected, then plain "Deselect all" (the
  count title beside it already shows the size). The toggle shares the
  title's text baseline. Deselect all empties the selection, which ends the
  mode. The count is an `aria-live="polite"` region.
- **Bottom.** A blue Delete pill (no count) and a grey Cancel pill replace the
  icon pill. Both use the dialog pill metrics (54 px, pill radius, 15 px /
  700). They sit 16 px under the last track inside the scrolling list body and
  are sticky: a list taller than the view keeps them floating at the bottom,
  14 px above the phone navigation (where the old pill sat) or 16 px from the
  panel bottom on tablet and desktop, and scrolling to the end returns them
  under the last track without covering it. After Delete the Undo pill
  slides with the last track to its new place.
- **Exits.** A tap or click anywhere outside the track list, the header toggle
  and the pills (the custom scrollbar excepted), any `ui:tab-changed` away
  from the playlist on phones and on the desktop grid, Escape, Deselect all,
  and the existing room, authority, session and system-audio exits.
- **Undo.** Delete hides the rows at once. The same pill animates to the
  centre and turns grey with an undo arrow and "Undo" while Cancel slides
  down out of view (300 ms, the app's `cubic-bezier(0.2, 0.8, 0.2, 1)`;
  `css/style.css` has no `--ease-*` tokens). After 3 s the Undo pill slides
  down and only then is `playlist:remove-tracks` emitted, so the PRO,
  Standard guest/operator and host removal paths are unchanged. With
  `prefers-reduced-motion: reduce` every step is instant.

## Pending deletion rules

- A new selection (or a new Delete) commits the pending one first, because
  its Undo pill is replaced.
- `pagehide` and `visibilitychange` to hidden commit at once (best effort).
- Room change, edit authority loss (`queue.mutate`, operator revoke, host
  connection change), session end and system audio drop it and show the rows
  again. System audio drops rather than commits because the host's removal
  path would start a successor track over the shared source.
- A commit re-checks `canRemove()` and the canonical playlist; rows that
  another device already removed are dropped, and a pending set that empties
  retires its pill.
- Re-renders filter pending rows out of the DOM, so reorder, follow and the
  current-row locator (hidden while Undo shows) never target them; row
  numbers are renumbered for the survivors.
- PRO and Standard guests keep committed rows hidden until the authoritative
  snapshot drops them, at most 10 s, after which a rejected or lost request
  shows them again. The Standard host removes synchronously.
- The current track keeps playing while it waits in the Undo window; the
  host's normal removal path picks the successor at commit.

## Focus

Pressing Delete keeps focus on the pill that becomes Undo. Undo hands focus
to the first restored row's X, a commit to the survivor row's X (never into a
hidden playlist), Cancel and Deselect all to the row that started the mode.

## Translations

Three new keys in all 42 locales: `common.delete`, `common.undo` and
`playlist.selected_count`, which is count-sensitive (`PLURAL_PARAM_BY_KEY`,
singular forms for locales with `pluralMessages`). Values come from the
WordPress core (`wp/dev`) PO exports fetched on 2026-10-20: msgid "%d selected"
for the count, "Delete" in its `verb` context where translated, and "Undo".
"WP" below means that string verbatim with `%d` → `{{count}}`.

| Locale  | `playlist.selected_count`                             | `common.delete` | `common.undo`      | Source                                                                                    |
| ------- | ----------------------------------------------------- | --------------- | ------------------ | ----------------------------------------------------------------------------------------- |
| en      | {{count}} selected                                    | Delete          | Undo               | source copy                                                                               |
| ko      | {{count}}개 선택됨                                    | 삭제하기        | 실행 취소          | owner wording (WP count "%d개 항목 선택됨" without 항목)                                   |
| ja      | {{count}}個を選択中                                   | 削除            | 元に戻す           | WP                                                                                        |
| zh-hans | 已选择 {{count}} 项                                   | 删除            | 撤销               | count: WP "%d Item selected"                                                              |
| zh-hant | {{count}} 個項目已選取                                | 刪除            | 復原               | WP                                                                                        |
| es      | {{count}} seleccionados (one: {{count}} seleccionado) | Borrar          | Deshacer           | count other: WP "%d selected"; one: WP "%s item selected"[0] without noun                 |
| pt-br   | {{count}} selecionados (one: {{count}} selecionado)   | Excluir         | Desfazer           | count: WP "%d item selected" forms without noun (WP "%d selected" is "selecionadas: %d")  |
| fr      | {{count}} sélectionnés (one: {{count}} sélectionné)   | Supprimer       | Annuler            | count: WP "%d item selected" forms without noun (WP "%d selected" is "%d sélection(s)")   |
| de      | {{count}} ausgewählt                                  | Löschen         | Rückgängig machen  | WP                                                                                        |
| nl      | {{count}} geselecteerd                                | Verwijderen     | Ongedaan maken     | WP                                                                                        |
| it      | {{count}} selezionati (one: {{count}} selezionato)    | Elimina         | Annulla            | count other: WP "%d selected"; one: WP "%s item selected"[0] without noun                 |
| pl      | Wybrano {{count}}                                     | Usuń            | Cofnij             | count: WP "%d item selected" forms ("Wybrano %d element/elementy/elementów") without noun |
| ru      | Выбрано: {{count}}                                    | Удалить         | Отменить           | WP (count-neutral form, same for all plural categories)                                   |
| tr      | {{count}} seçilmiş                                    | Sil             | Geri al            | WP                                                                                        |
| id      | {{count}} dipilih                                     | Hapus           | Batalkan           | WP                                                                                        |
| vi      | {{count}} được chọn                                   | Xóa             | Hoàn tác           | WP                                                                                        |
| th      | {{count}} รายการที่เลือก                              | ลบ              | ย้อนกลับ           | count: WP "%s item selected"                                                              |
| hi      | {{count}} चयन किया गया                                | मिटाएं          | पूर्ववत करें       | WP; Undo from MediaWiki `editundo` (WP "पहले जैसा" reads "as before")                  |
| bn      | {{count}}টি নির্বাচিত                                 | মুছে ফেলুন      | পূর্বাবস্থা        | WP                                                                                        |
| ta      | {{count}} தேர்வுகள்                                   | நீக்கு          | செயல்தவிர்         | WP (trailing period dropped)                                                              |
| te      | ఎంచుకున్నవి: {{count}}                                | తొలగించు        | రద్దుచెయ్యి        | WP; Undo from MediaWiki `editundo` (WP "చెయ్యకు" reads "don't do")                     |
| ms      | {{count}} dipilih                                     | Padam           | Buat asal          | WP                                                                                        |
| fil     | {{count}} pinili                                      | Burahin         | Ibalik             | count/delete: WP; undo: app vocabulary (WP leaves "Undo" untranslated)                    |
| ar      | عدد العناصر المحدّدة: {{count}}                       | حذف             | تراجع              | WP (count-neutral form)                                                                   |
| ur      | {{count}} منتخب شدہ                                   | حذف کریں        | کالعدم کریں        | WP                                                                                        |
| he      | {{count}} נבחרו (one: נבחר פריט {{count}})            | מחק             | ביטול פעולה אחרונה | count other: WP "%d selected"; one: WP "%s item selected"[0]                              |
| uk      | Вибрано: {{count}}                                    | Видалити        | Скасувати          | WP                                                                                        |
| ro      | Selectate: {{count}}                                  | Șterge          | Anulează           | WP (count-neutral form)                                                                   |
| cs      | Vybráno: {{count}}                                    | Odstranit       | Zpět               | count: app vocabulary (WP "%d selected" is "Zvolené soubory: %d", files); delete/undo: WP |
| el      | Επιλεγμένα: {{count}}                                 | Διαγραφή        | Αναίρεση           | count: app count-neutral pattern (WP "%d έχουν επιλεγεί" is plural-only); delete/undo: WP |
| fa      | گزینش‌شده: {{count}}                                  | حذف             | بازگردانی          | WP                                                                                        |
| mr      | {{count}} निवडले आहे                                  | काढून टाका      | उलटवा              | WP; Undo from MediaWiki `editundo` (WP "पाठीमागे" reads "behind")                      |
| gu      | {{count}} પસંદ કરેલ છે                                | કાઢી નાખો       | પૂર્વવત્ કરો       | WP                                                                                        |
| kn      | ಆರಿಸಿದವುಗಳು: {{count}}                                | ಅಳಿಸು           | ರದ್ದು ಮಾಡು         | WP (space before colon removed)                                                           |
| ml      | {{count}} തെരഞ്ഞെടുത്തു                               | ഇല്ലാതാക്കുക    | മാറ്റി ചെയ്യുക     | count/undo: WP; delete: app vocabulary (WP "ഏടുത്തുകളയുക" looks misspelled)               |
| pa      | {{count}} ਚੁਣੇ ਹੋਏ                                    | ਮਿਟਾਓ           | ਅਣਕੀਤਾ ਕਰੋ         | WP                                                                                        |
| sv      | {{count}} valda (one: {{count}} vald)                 | Ta bort         | Ångra              | count other: WP "%d selected"; one: singular of the same participle                       |
| da      | {{count}} valgt                                       | Slet            | Fortryd            | WP                                                                                        |
| nb      | {{count}} er valgt                                    | Slett           | Angre              | WP                                                                                        |
| fi      | {{count}} valittu                                     | Poista          | Kumoa              | WP                                                                                        |
| hu      | {{count}} kijelölve                                   | Törlés          | Visszavonás        | WP                                                                                        |
| bg      | Избрани: {{count}}                                    | Изтриване       | Отмяна             | WP                                                                                        |

## Verification

Code: `agent/delete-mode` at `d07367cb` on top of main `e1ed16d6`. Windows 11,
Node 24.20.0.

- Pass: `npm run typecheck`, `npm run lint`, `npm run format:check`,
  `npx vitest run src/i18n src/ui src/player --maxWorkers=6`
  (170 files, 3472 tests), `guard:dead-exports`, `guard:bus-pairing`,
  `guard:import-graph`.
- Pass: a throwaway Playwright capture on the e2e preview build (Chromium,
  local PeerJS host, three uploaded files) at 390×844 and 1440×900 in dark
  and light: selection header and pills, all selected, the morph at 40 ms and
  100 ms, the centred Undo pill, and the list after commit with two rows
  left. With reduced motion, no animation runs on the pills after Delete.
- Later owner refinements (sticky placement, Undo following the last track,
  the toggle total and baseline, Korean labels, and the te/mr/hi Undo words)
  and the e2e results are recorded in the combined batch report,
  [playlist and platform fixes](playlist-and-platform-fixes-2026-10-20.md).
- Not checked: real phones, screen readers, and how long-translation headers
  ellipsize at 360 px.
