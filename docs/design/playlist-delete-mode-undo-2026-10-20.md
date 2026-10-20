# Playlist delete mode — 2026-10-20

- Status: owner decision 2026-10-21 removed the 3 s Undo window and the
  playback-navigation gate added for it. Delete now deletes at once and the
  deleting device alone gets a "Deleted N tracks" toast. The sections below
  describe the current behaviour; the Undo design is summarised under
  [Removed Undo window](#removed-undo-window-2026-10-21).

## Request

The owner asked for a new multi-select deletion mode in the playlist. The old
mode floated one blue pill with icon buttons (select all, delete with a count
badge, cancel) and deleted at once.

## Change

- **Header.** While rows are selected, the "Playlist" title reads
  `playlist.selected_count` ("2 selected", Korean "2개 선택됨"), keeping the
  title's size and weight. Repeat, shuffle and add media are hidden and one
  text button in the title's neutral `--text-main` colour (blue until the
  owner's 2026-10-21 change) sits on the right: "Select all (N)" with the playlist
  total until every visible row is selected, then plain "Deselect all" (the
  count title beside it already shows the size). The toggle shares the
  title's text baseline. Deselect all empties the selection, which ends the
  mode. The count is an `aria-live="polite"` region.
- **Bottom.** A red Delete pill (`--danger-filled`, white label, no count) and
  a grey Cancel pill (`--surface-2`, `--text-main`) sit inside one container
  pill (`--surface-1`, 6 px padding and gap, pill radius, and the light
  dialog grey button's `1px solid var(--glass-border)` stroke, which is
  transparent in dark and has its own value in the high-contrast palettes; no
  shadow). The inner pills keep the dialog pill metrics (54 px, 15 px / 700).
  The container sits 16 px under the last track inside the scrolling list
  body and is sticky: a list taller than the view keeps it floating at the
  bottom, 14 px above the phone navigation or 16 px from the panel bottom on
  tablet and desktop, and scrolling to the end returns it under the last
  track without covering it.
- **Exits.** A tap or click anywhere outside the track list, the header toggle
  and the pills (the custom scrollbar excepted), any `ui:tab-changed` away
  from the playlist on phones and on the desktop grid, Escape, Cancel,
  Deselect all, Delete, and the existing room, authority, session and
  system-audio exits. Whenever the mode ends with the playlist on screen, the
  whole container slides down 24 px and fades out as one unit (300 ms, the
  app's `cubic-bezier(0.2, 0.8, 0.2, 1)`); a new selection during the exit
  cancels it and replays the entry. Off screen or with
  `prefers-reduced-motion: reduce` it hides at once. Pills on their way out
  ignore taps.
- **Delete.** Pressing Delete emits `playlist:remove-tracks` at once with the
  selected ids in playlist order, through the unchanged PRO, Standard
  guest/operator and host removal paths, and ends the mode. The surviving rows
  glide to their new places (300 ms). The exit animation never delays the
  deletion.

## Deletion toast (owner decision 2026-10-21)

- `toast.deleted_tracks` ("Deleted {{count}} tracks", Korean "트랙 {{count}}개를
  삭제했어요") is shown only on the deleting device, through the local
  `ui:show-toast` event. Nothing is broadcast.
- It appears when the canonical playlist no longer holds any row of that
  deletion, not when the request is sent: synchronously on the Standard host,
  and when the authoritative snapshot arrives for a PRO member or a Standard
  guest/operator. A request the room refuses or never answers shows no toast
  (PRO failures keep their existing `error.network_generic` toast), so the app
  never claims a deletion that did not happen. A deletion that settles after
  this device lost `queue.mutate` (for example leaving the room, which also
  empties the list) is not reported.
- Remote paths keep the deleted rows hidden until the snapshot drops them, at
  most 10 s; then rows of a rejected or lost request show again. Hidden rows
  are left out of the rendered list, so reorder, follow and the current-row
  locator never target them, and survivors are renumbered.

## Focus

Delete hands focus that was on the pills to the survivor row's X (never into
a hidden playlist); Cancel and Deselect all return it to the row that started
the mode.

## Removed Undo window (2026-10-21)

Until 2026-10-21 Delete hid the rows, morphed into a grey Undo pill for 3 s
and only then emitted `playlist:remove-tracks`; commit `0e00c0e0` then made
every playback navigation commit a pending deletion first. The owner removed
both: deletion already takes two actions (tap X to select, then Delete), and
an Undo window risked disasters in PRO rooms. Removed with it: the Undo pill,
its morph and exit, the pending-deletion state and its commit/drop API, the
`pagehide`/`visibilitychange` commit, `src/player/queue-removal-gate.ts`,
`src/pro-room/queue-removal-wait.ts`, the PRO playback controller's removal
wait and `removeMany`'s `onApplied` hook, the near-end commit, and the
`common.undo` key in all 42 locales.

## Translations

Two keys from the redesign remain in all 42 locales: `common.delete` and
`playlist.selected_count`, which is count-sensitive (`PLURAL_PARAM_BY_KEY`,
singular forms for locales with `pluralMessages`). Values come from the
WordPress core (`wp/dev`) PO exports fetched on 2026-10-20: msgid "%d selected"
for the count and "Delete" in its `verb` context where translated. "WP" below
means that string verbatim with `%d` → `{{count}}`.

| Locale  | `playlist.selected_count`                             | `common.delete` | Source                                                                                    |
| ------- | ----------------------------------------------------- | --------------- | ----------------------------------------------------------------------------------------- |
| en      | {{count}} selected                                    | Delete          | source copy                                                                               |
| ko      | {{count}}개 선택됨                                    | 삭제하기        | owner wording (WP count "%d개 항목 선택됨" without 항목)                                  |
| ja      | {{count}}個を選択中                                   | 削除            | WP                                                                                        |
| zh-hans | 已选择 {{count}} 项                                   | 删除            | count: WP "%d Item selected"                                                              |
| zh-hant | {{count}} 個項目已選取                                | 刪除            | WP                                                                                        |
| es      | {{count}} seleccionados (one: {{count}} seleccionado) | Borrar          | count other: WP "%d selected"; one: WP "%s item selected"[0] without noun                 |
| pt-br   | {{count}} selecionados (one: {{count}} selecionado)   | Excluir         | count: WP "%d item selected" forms without noun (WP "%d selected" is "selecionadas: %d")  |
| fr      | {{count}} sélectionnés (one: {{count}} sélectionné)   | Supprimer       | count: WP "%d item selected" forms without noun (WP "%d selected" is "%d sélection(s)")   |
| de      | {{count}} ausgewählt                                  | Löschen         | WP                                                                                        |
| nl      | {{count}} geselecteerd                                | Verwijderen     | WP                                                                                        |
| it      | {{count}} selezionati (one: {{count}} selezionato)    | Elimina         | count other: WP "%d selected"; one: WP "%s item selected"[0] without noun                 |
| pl      | Wybrano {{count}}                                     | Usuń            | count: WP "%d item selected" forms ("Wybrano %d element/elementy/elementów") without noun |
| ru      | Выбрано: {{count}}                                    | Удалить         | WP (count-neutral form, same for all plural categories)                                   |
| tr      | {{count}} seçilmiş                                    | Sil             | WP                                                                                        |
| id      | {{count}} dipilih                                     | Hapus           | WP                                                                                        |
| vi      | {{count}} được chọn                                   | Xóa             | WP                                                                                        |
| th      | {{count}} รายการที่เลือก                              | ลบ              | count: WP "%s item selected"                                                              |
| hi      | {{count}} चयन किया गया                                | मिटाएं          | WP                                                                                        |
| bn      | {{count}}টি নির্বাচিত                                 | মুছে ফেলুন      | WP                                                                                        |
| ta      | {{count}} தேர்வுகள்                                   | நீக்கு          | WP (trailing period dropped)                                                              |
| te      | ఎంచుకున్నవి: {{count}}                                | తొలగించు        | WP                                                                                        |
| ms      | {{count}} dipilih                                     | Padam           | WP                                                                                        |
| fil     | {{count}} pinili                                      | Burahin         | WP                                                                                        |
| ar      | عدد العناصر المحدّدة: {{count}}                       | حذف             | WP (count-neutral form)                                                                   |
| ur      | {{count}} منتخب شدہ                                   | حذف کریں        | WP                                                                                        |
| he      | {{count}} נבחרו (one: נבחר פריט {{count}})            | מחק             | count other: WP "%d selected"; one: WP "%s item selected"[0]                              |
| uk      | Вибрано: {{count}}                                    | Видалити        | WP                                                                                        |
| ro      | Selectate: {{count}}                                  | Șterge          | WP (count-neutral form)                                                                   |
| cs      | Vybráno: {{count}}                                    | Odstranit       | count: app vocabulary (WP "%d selected" is "Zvolené soubory: %d", files); delete: WP      |
| el      | Επιλεγμένα: {{count}}                                 | Διαγραφή        | count: app count-neutral pattern (WP "%d έχουν επιλεγεί" is plural-only); delete: WP      |
| fa      | گزینش‌شده: {{count}}                                  | حذف             | WP                                                                                        |
| mr      | {{count}} निवडले आहे                                  | काढून टाका      | WP                                                                                        |
| gu      | {{count}} પસંદ કરેલ છે                                | કાઢી નાખો       | WP                                                                                        |
| kn      | ಆರಿಸಿದವುಗಳು: {{count}}                                | ಅಳಿಸು           | WP (space before colon removed)                                                           |
| ml      | {{count}} തെരഞ്ഞെടുത്തു                               | ഇല്ലാതാക്കുക    | count: WP; delete: app vocabulary (WP "ഏടുത്തുകളയുക" looks misspelled)                    |
| pa      | {{count}} ਚੁਣੇ ਹੋਏ                                    | ਮਿਟਾਓ           | WP                                                                                        |
| sv      | {{count}} valda (one: {{count}} vald)                 | Ta bort         | count other: WP "%d selected"; one: singular of the same participle                       |
| da      | {{count}} valgt                                       | Slet            | WP                                                                                        |
| nb      | {{count}} er valgt                                    | Slett           | WP                                                                                        |
| fi      | {{count}} valittu                                     | Poista          | WP                                                                                        |
| hu      | {{count}} kijelölve                                   | Törlés          | WP                                                                                        |
| bg      | Избрани: {{count}}                                    | Изтриване       | WP                                                                                        |

`toast.deleted_tracks` (count-sensitive, in `PLURAL_PARAM_BY_KEY`) follows each locale's
existing `toast.added_tracks` toast: the same word for track(s), the same sentence shape and the same
plural categories, with the past-tense delete verb the locale already uses for `playlist.delete_selected`.
English and Korean are the owner's wording.

| Locale  | `toast.deleted_tracks`                                                                                                                             | Pattern (`toast.added_tracks`)        |
| ------- | -------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------- |
| ar      | تم حذف {{count}} من المقاطع (one: تم حذف {{count}} مقطع; two: تم حذف {{count}} مقطعين; few: تم حذف {{count}} مقاطع; many: تم حذف {{count}} مقطعًا) | تمت إضافة {{count}} من المقاطع        |
| bg      | Изтрити песни: {{count}}                                                                                                                           | Добавени песни: {{count}}             |
| bn      | {{count}}টি ট্র্যাক মুছে ফেলা হয়েছে                                                                                                               | {{count}}টি ট্র্যাক যোগ করা হয়েছে    |
| cs      | Smazáno skladeb: {{count}}                                                                                                                         | Přidáno skladeb: {{count}}            |
| da      | {{count}} numre blev slettet (one: {{count}} nummer blev slettet)                                                                                  | {{count}} numre blev tilføjet         |
| de      | {{count}} Titel gelöscht (one: {{count}} Titel gelöscht)                                                                                           | {{count}} Titel hinzugefügt           |
| el      | Κομμάτια που διαγράφηκαν: {{count}}                                                                                                                | Κομμάτια που προστέθηκαν: {{count}}   |
| en      | Deleted {{count}} tracks                                                                                                                           | {{count}} tracks added                |
| es      | {{count}} pistas eliminadas (one: {{count}} pista eliminada)                                                                                       | {{count}} pistas añadidas             |
| fa      | {{count}} قطعه حذف شد                                                                                                                              | {{count}} قطعه اضافه شد               |
| fi      | Poistettiin {{count}} kappaletta (one: Poistettiin {{count}} kappale)                                                                              | Lisättiin {{count}} kappaletta        |
| fil     | {{count}} track ang na-delete                                                                                                                      | {{count}} track ang idinagdag         |
| fr      | {{count}} pistes supprimées (one: {{count}} piste supprimée)                                                                                       | {{count}} pistes ajoutées             |
| gu      | {{count}} ટ્રૅક કાઢી નાખ્યા (one: કાઢી નાખેલા ટ્રૅકની સંખ્યા: {{count}})                                                                           | {{count}} ટ્રૅક ઉમેર્યા               |
| he      | נמחקו {{count}} רצועות (one: נמחקה {{count}} רצועה)                                                                                                | נוספו {{count}} רצועות                |
| hi      | {{count}} ट्रैक मिटाए गए (one: {{count}} ट्रैक मिटाया गया)                                                                                         | {{count}} ट्रैक जोड़े गए              |
| hu      | {{count}} szám törölve                                                                                                                             | {{count}} szám hozzáadva              |
| id      | {{count}} media dihapus                                                                                                                            | {{count}} media ditambahkan           |
| it      | {{count}} tracce eliminate (one: {{count}} traccia eliminata)                                                                                      | {{count}} tracce aggiunte             |
| ja      | トラックを{{count}}件削除しました                                                                                                                  | トラックを{{count}}件追加しました     |
| kn      | {{count}} ಟ್ರ್ಯಾಕ್‌ಗಳನ್ನು ಅಳಿಸಲಾಗಿದೆ (one: {{count}} ಟ್ರ್ಯಾಕ್ ಅಳಿಸಲಾಗಿದೆ)                                                                          | {{count}} ಟ್ರ್ಯಾಕ್‌ಗಳನ್ನು ಸೇರಿಸಲಾಗಿದೆ |
| ko      | 트랙 {{count}}개를 삭제했어요                                                                                                                      | 트랙 {{count}}개를 추가했어요         |
| ml      | {{count}} ട്രാക്കുകൾ ഇല്ലാതാക്കി (one: {{count}} ട്രാക്ക് ഇല്ലാതാക്കി)                                                                             | {{count}} ട്രാക്കുകൾ ചേർത്തു          |
| mr      | {{count}} ट्रॅक हटवले (one: {{count}} ट्रॅक हटवला)                                                                                                 | {{count}} ट्रॅक जोडले                 |
| ms      | {{count}} trek dipadam                                                                                                                             | {{count}} trek ditambah               |
| nb      | {{count}} spor ble slettet                                                                                                                         | {{count}} spor ble lagt til           |
| nl      | {{count}} tracks verwijderd (one: {{count}} track verwijderd)                                                                                      | {{count}} tracks toegevoegd           |
| pa      | {{count}} ਟਰੈਕ ਮਿਟਾਏ ਗਏ (one: ਮਿਟਾਏ ਗਏ ਟਰੈਕਾਂ ਦੀ ਗਿਣਤੀ: {{count}})                                                                                 | {{count}} ਟਰੈਕ ਜੋੜੇ ਗਏ                |
| pl      | Usunięte materiały: {{count}} (one: Usunięto {{count}} materiał; few: Usunięto {{count}} materiały; many: Usunięto {{count}} materiałów)           | Dodane materiały: {{count}}           |
| pt-br   | {{count}} faixas excluídas (one: {{count}} faixa excluída)                                                                                         | {{count}} faixas adicionadas          |
| ro      | {{count}} piste șterse (one: {{count}} pistă ștearsă; other: {{count}} de piste șterse)                                                            | {{count}} piste adăugate              |
| ru      | Удалено материалов: {{count}} (one: Удалён {{count}} материал; few: Удалено {{count}} материала; many: Удалено {{count}} материалов)               | Добавлено материалов: {{count}}       |
| sv      | {{count}} spår har raderats                                                                                                                        | {{count}} spår har lagts till         |
| ta      | {{count}} டிராக்குகள் நீக்கப்பட்டன (one: {{count}} டிராக் நீக்கப்பட்டது)                                                                           | {{count}} டிராக்குகள் சேர்க்கப்பட்டன  |
| te      | {{count}} ట్రాక్‌లు తొలగించబడ్డాయి (one: {{count}} ట్రాక్ తొలగించబడింది)                                                                           | {{count}} ట్రాక్‌లు జోడించబడ్డాయి     |
| th      | ลบ {{count}} รายการแล้ว                                                                                                                            | เพิ่ม {{count}} รายการแล้ว            |
| tr      | {{count}} medya öğesi silindi                                                                                                                      | {{count}} medya öğesi eklendi         |
| uk      | Видалено треків: {{count}}                                                                                                                         | Додано треків: {{count}}              |
| ur      | {{count}} ٹریک حذف ہوئے (one: {{count}} ٹریک حذف ہوا)                                                                                              | {{count}} ٹریک شامل ہوئے              |
| vi      | Đã xóa {{count}} mục                                                                                                                               | Đã thêm {{count}} mục                 |
| zh-hans | 已删除 {{count}} 个媒体项                                                                                                                          | 已添加 {{count}} 个媒体项             |
| zh-hant | 已刪除 {{count}} 項                                                                                                                                | 已新增 {{count}} 項                   |

## Verification

2026-10-20 redesign: `agent/delete-mode` at `d07367cb` on top of main
`e1ed16d6`. Typecheck, lint, format, unit tests and a throwaway Playwright
capture at 390×844 and 1440×900 passed; later refinements and the e2e results
are in the combined batch report,
[playlist and platform fixes](playlist-and-platform-fixes-2026-10-20.md).

2026-10-21 Undo removal: `agent/playlist-ux-batch` on `38ecee0b` with the
revert of `0e00c0e0` and the Undo removal commit, Windows 11, Node 24.20.0.

- Pass: `npm run typecheck`, `npm run lint`, `npm run format:check`,
  `guard:bus-pairing`, `guard:dead-exports`, `guard:import-graph`,
  `guard:room-authority-boundaries` (main's playlist-view fingerprints apply
  again), `guard:source-complexity`, `guard:standard-room-hot-path`, full
  `npx vitest run --maxWorkers=6` (601 files, 13,569 tests), `npm run build`
  and `guard:initial-transfer-budget`: eager JS 490,597 B gzip against the
  491,568 B ceiling, 971 B headroom (58 B before).
- Pass on the e2e build, Chromium: `playlist`, `playlist-touch-reorder`,
  `playlist-desktop-reorder`, `visualizer-layout`, `design-system-page`,
  `edge-cases` and `complex-scenarios` (78 tests). `playlist.test.ts` asserts
  the host's toast and no toast on the guest. The `visualizer-layout` nav
  clearance case had failed since the sticky change (`efd73c67`) because it
  read the old fixed-bar offset; it now checks the sticky `-10px` against the
  body clearance.
- Pass: a throwaway capture at 390×844 and 1440×900 in light and dark, plus
  390×844 high contrast: container `--surface-1`, 6 px padding and gap,
  `--glass-border` stroke (0.06 black in light, transparent in dark, #d4d6d8
  and #262626 in high contrast), no shadow, 68 px tall with 54 px pills; the
  exit frame at 120 ms and the "Deleted 1 track" toast after it.
- Not run: the e2e specs that only lost their Undo wait (`chaos-scenarios`,
  `chaos-scenarios-2`, `luna-session-sequences`, `youtube-sync`), WebKit.

Not checked: real phones, screen readers, and how long-translation headers
ellipsize at 360 px.
