/**
 * ChatsArea.tsx
 * Full-screen chats view (when user chooses the Chats tab explicitly).
 * Identical grid as the in-history chats pane, just occupying the whole main.
 */

import { ChatsGrid } from './ChatsGrid';
import './ChatsArea.css';

export function ChatsArea() {
  return (
    <div class="chats-area">
      <ChatsGrid />
    </div>
  );
}
