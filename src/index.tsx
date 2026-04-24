import { render } from 'solid-js/web';
import './lib/monaco-workers';
import { registerMonacoThemes } from './lib/monaco-theme';
// Self-hosted JetBrains Mono with full Cyrillic coverage — avoids per-character
// fallback in xterm which causes Russian glyphs to jump vertically.
import '@fontsource/jetbrains-mono/400.css';
import '@fontsource/jetbrains-mono/500.css';
import '@fontsource/jetbrains-mono/cyrillic-400.css';
import '@fontsource/jetbrains-mono/cyrillic-500.css';
import App from './App';
import { installEditableContextMenu } from './lib/editable-context-menu';

registerMonacoThemes();
installEditableContextMenu();

render(() => <App />, document.getElementById('root') as HTMLElement);
