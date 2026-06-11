# Аудит ClaudeDesk — /improve (2026-06-11)

Аудит по командe `/improve` (skill от shadcn). Кодовую базу просканировали 4 параллельных
аудитора (correctness, security, perf+техдолг, tests/deps/DX/docs/направление), после чего
каждая значимая находка проверена вручную по коду (фаза vetting). Ниже — только то, что
подтвердилось. Планы исполнения — в этой же папке (`001…005`), индекс в `README.md`.

Не аудировалось: `docker/`, `scripts/`, сборочные конфиги electron-builder, `src/arena/`
(бегло), upstream-код parallel-code без локальных правок.

## Подтверждённые находки (по убыванию выгоды)

| #   | Находка                                                                                                                                                   | Категория | Impact                                                  | Effort | Risk | Доказательства                                                                                          |
| --- | --------------------------------------------------------------------------------------------------------------------------------------------------------- | --------- | ------------------------------------------------------- | ------ | ---- | ------------------------------------------------------------------------------------------------------- |
| 1   | Tree-вкладка читает ВСЕ ~500+ JSONL целиком при каждом открытии: `readFileMeta` без кэша, последовательно, `statSync`/`createReadStream` на main-процессе | perf      | HIGH (секунды лага, фризы всех окон)                    | M      | LOW  | `electron/ipc/session-lineage.ts:200-213` (serial `await` в цикле), `:72-115` (полное чтение, кэша нет) |
| 2   | Remote-сервер: нет Origin-проверки на WS-upgrade (`verifyClient` → `cb(true)`), токен живёт в `localStorage` бессрочно, нет CSP                           | security  | MED (CSWSH-попытки, утечка токена через XSS/расширения) | S      | LOW  | `electron/remote/server.ts:217-228`, `src/remote/auth.ts:9,16`                                          |
| 3   | CI не гоняет ни юнит-, ни e2e-тесты — только typecheck/lint/format                                                                                        | dx        | MED (регрессии видны только на машине разработчика)     | S      | LOW  | `.github/workflows/ci.yml` (3 шага quality)                                                             |
| 4   | 13 пустых `catch {}` только в `chats.ts`+`session-history.ts`; ошибки бранча/ренейма/списка глотаются молча                                               | tech-debt | MED (отладка вслепую)                                   | S      | LOW  | `src/store/chats.ts`, `electron/ipc/session-history.ts` (grep `catch {`)                                |
| 5   | 151 `waitForTimeout` в 33 e2e-спеках (projects: 18, ui-clipboard: 15, scrollback-no-hang: 12, smoke: 12) — источник флаков                                | tests     | MED                                                     | M      | LOW  | `e2e/*.spec.ts` (подсчёт 2026-06-11)                                                                    |
| 6   | live-watch (`resolveLiveSessionId`) поллит каталог каждые 2с до 3 мин на каждый resumed-тайл, `readdirSync`+`statSync` на main                            | perf      | LOW-MED (фоновый шум I/O при 6-12 тайлах)               | M      | MED  | `electron/ipc/session-lineage.ts:336-373`                                                               |
| 7   | mermaid-SVG вставляется в `innerHTML` без прогона через DOMPurify (полагаемся только на санацию самого mermaid)                                           | security  | LOW (defense-in-depth)                                  | S      | LOW  | `src/components/PlanViewerDialog.tsx` (innerHTML = svg)                                                 |
| 8   | `npm run release` пушит тег без тестов (`typecheck && npm version patch && git push`) — конфликтует с правилом «пуш только по команде»                    | dx        | LOW                                                     | S      | LOW  | `package.json:27`                                                                                       |
| 9   | xterm и аддоны запинены на beta-версии (`6.1.0-beta.195` и т.п.)                                                                                          | deps      | LOW                                                     | S      | MED  | `package.json:34-37`                                                                                    |
| 10  | Нет тестов у самых сложных модулей: `TerminalView.tsx` (~1050 строк, PTY-гейты), `src/remote/*`, `electron/main.ts` (fixEnv)                              | tests     | MED                                                     | L      | MED  | отсутствие соответствующих `*.test.ts`                                                                  |
| 11  | `chats.ts` — 908 строк, 5 несвязанных обязанностей (state+persist+spawn+branch+live-watch)                                                                | tech-debt | MED                                                     | L      | MED  | `src/store/chats.ts`                                                                                    |
| 12  | README противоречит release-workflow (заявлено «DMG/AppImage не публикуются», CI их собирает)                                                             | docs      | LOW                                                     | S      | LOW  | README vs `.github/workflows/release.yml`                                                               |

В планы (по умолчанию топ-5 по выгоде, режим без интерактива) превращены находки 1-5.
Находки 6-12 — кандидаты на следующий заход (`/improve reconcile` или ручной выбор).

## Рассмотрено и ОТКЛОНЕНО (чтобы не аудировать повторно)

- **«data-mermaid вырезается DOMPurify»** — ложь: DOMPurify по умолчанию разрешает все
  `data-*` атрибуты (`ALLOW_DATA_ATTR: true`); `marked-shiki.ts:47` работает корректно.
- **«Remote = RCE для любого в LAN»** — преувеличение: auth обязателен для
  input/kill/subscribe (`server.ts:304`), неаутентифицированных рвут через 5с (`:277`),
  токен — `randomBytes(24)` + `timingSafeEqual`, новый на каждый запуск. Остаточные
  риски — в плане 002.
- **«Арена — мёртвый код»** — ложь: `ArenaOverlay` смонтирован в `App.tsx:887`.
- **«base64-декодер падает на битом вводе» (`TerminalView.tsx:37`)** — ложь: условие
  цикла `i < end` гарантирует первый символ; отсутствие guard'а корректно по построению.
- **«Гонка restore: forkParent теряется из-за watchLiveSession»** — невозможно:
  restore-цикл синхронный, IPC-ответ (микротаска) не может вклиниться до его конца;
  в `adoptLiveSessionId` есть staleness-guard.
- **«watchLiveSession — stale closure»** — guard `cur.sessionId !== fromSid` уже есть.
- **«Гейт открывается дважды → PTY-байты выше транскрипта»** — неверно прочитан код:
  guard `!prePtyGateOpen` (`TerminalView.tsx:954`) при таймауте просто пропускает
  префилл (задокументированный предохранитель), порядок не ломается.
- **«preload allowlist дрейфует молча»** — в `main.ts:101-115` есть
  `verifyPreloadAllowlist()` с dev-предупреждением. Генерация из enum — nice-to-have.
- **«listSessions перечитывает все JSONL при каждом открытии History»** — преувеличение:
  разбор кэшируется по mtime (`session-history.ts:718`); остаётся только дешёвый
  stat-обход.
- Отчёт первого correctness-аудитора целиком (цитировал файлы из другого репозитория).
