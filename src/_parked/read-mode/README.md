# Припаркованный «режим чтения» (📖)

Здесь лежит выключенная из активного кода фича **режима чтения** — чистый
read-only рендер переписки claude (●/⎿/❯), который раньше открывался кнопкой 📖
и **автоматически при прокрутке колесом вверх** над живым терминалом.

**Почему убрано (2026-06-19):** по просьбе владельца — авто-включение при скролле
вверх мешало, а сам режим чтения он счёл лишним. Живой терминал claude теперь
всегда «голый» (как в upstream parallel-code): xterm владеет колесом сам, никакого
переключения. Файлы НЕ удалены — припаркованы здесь для возможного возврата.

> Контекст и доказательная база — `docs/wiki/conpty-vs-real-pty-scroll.md` и
> `docs/wiki/read-mode-clean-view.md`.

## Что припарковано
- `TranscriptView.tsx` — сам компонент read-only вида (был в `src/components/`).
- e2e-спеки переименованы в `e2e/*.spec.ts.parked` (Playwright их не подхватывает):
  `read-mode`, `claude-live-scroll`, `chat-scrollback`, `scrollback-1000-lines`,
  `scrollback-no-hang`.
- Хелпер `openReadMode` оставлен в `e2e/helpers.ts` (не используется активными
  спеками; нужен припаркованным).
- `src/_parked` исключён из `tsconfig.json` (`exclude`), поэтому `tsc --noEmit`
  и vite его не трогают.

## Как вернуть
1. Перенести `TranscriptView.tsx` обратно в `src/components/` (проверить
   относительные импорты — здесь они «съехали» на один уровень).
2. Снять `e2e/*.spec.ts.parked` → `*.spec.ts`.
3. В `src/components/ChatsGrid.tsx` вернуть:
   - импорт `import { TranscriptView } from './TranscriptView';`
   - сигналы `readMode/autoRead/readRefresh` + функции `toggleReadMode`,
     `engageReadFromScroll`, `disengageReadToLive`, мемо `showRead`;
   - кнопку 📖 в шапке тайла (`.chat-tile__read`);
   - живой терминал прятать `style={showRead() ? {display:'none'} : undefined}`,
     `autoFocus/isFocused = isActive() && !showRead()`, проп
     `onScrollUp={engageReadFromScroll}`;
   - панель чтения: `<Show when={showRead()}><div class="chat-tile__read-pane">
     <TranscriptView sessionId=… refreshKey={readRefresh()}
     onReachedBottom={disengageReadToLive} /></div></Show>`.
4. В `src/components/TerminalView.tsx` вернуть проп `onScrollUp?: () => void` и в
   обработчике колеса для claude-терминала: `if (e.deltaY < 0) props.onScrollUp?.();
   e.preventDefault(); e.stopPropagation();` вместо нынешнего `return`.
5. Вернуть CSS в `ChatsGrid.css` — снятые блоки сохранены в `read-mode.css.txt`
   рядом (стили `.chat-tile__read-pane`, `.chat-tile__read`, скрытие скроллбара
   живого терминала).
