/**
 * DialogShell.tsx
 *
 * Skeleton wrapper for the 11 *Dialog.tsx files in this folder. They all
 * repeat the same three slots (title bar with optional close button,
 * scrollable body, footer with Cancel/Submit-style buttons) on top of the
 * lower-level <Dialog> primitive — DialogShell collapses that boilerplate
 * into one declaration.
 *
 *   <DialogShell
 *     open={open()}
 *     title="Push to Remote"
 *     width="480px"
 *     onClose={onCancel}
 *     footer={
 *       <DialogFooter>
 *         <DialogCancelButton onClick={onCancel} label="Cancel" />
 *         <DialogPrimaryButton onClick={onConfirm} label="Push" />
 *       </DialogFooter>
 *     }
 *   >
 *     {body}
 *   </DialogShell>
 *
 * No DOM or behaviour changes vs the inline version — same panel, same
 * footer alignment, same theme tokens. Migration is opt-in: existing
 * dialogs that haven't been converted keep working unchanged.
 *
 * `useDialogFieldNav` is a tiny hook that wires Enter inside form
 * <input>/<textarea> fields to advance focus to the next field within
 * a given root element. Designed for future migrations; not yet used by
 * the three pilot dialogs in B4.
 */

import { Show, createEffect, onCleanup, type Accessor, type JSX } from 'solid-js';
import { Dialog } from './Dialog';
import { theme } from '../lib/theme';

export interface DialogShellProps {
  /** Mirrors Dialog.open — when false, nothing renders. */
  open: boolean;
  /** Heading text rendered above the body. */
  title: string;
  /** Called when the user presses Escape, clicks the overlay, or the optional ✕ button. */
  onClose: () => void;
  /** Optional explicit width (default: Dialog's 400px). */
  width?: string;
  /** Optional explicit z-index (default: Dialog's 1000). */
  zIndex?: number;
  /** Render an explicit ✕ in the title bar. Most dialogs leave this off and rely on overlay/Escape. */
  showCloseButton?: boolean;
  /** Footer slot — typically DialogFooter with cancel + primary buttons. */
  footer?: JSX.Element;
  /** Body slot. */
  children: JSX.Element;
  /** Optional override for the panel style (forwarded to <Dialog>). */
  panelStyle?: JSX.CSSProperties;
}

export function DialogShell(props: DialogShellProps) {
  return (
    <Dialog
      open={props.open}
      onClose={props.onClose}
      {...(props.width !== undefined ? { width: props.width } : {})}
      {...(props.zIndex !== undefined ? { zIndex: props.zIndex } : {})}
      {...(props.panelStyle !== undefined ? { panelStyle: props.panelStyle } : {})}
    >
      <div
        style={{
          display: 'flex',
          'align-items': 'center',
          gap: '8px',
        }}
      >
        <h2
          style={{
            margin: '0',
            'font-size': '17px',
            color: theme.fg,
            'font-weight': '600',
            flex: '1',
          }}
        >
          {props.title}
        </h2>
        <Show when={props.showCloseButton}>
          <button
            type="button"
            aria-label="Close"
            onClick={() => props.onClose()}
            style={{
              padding: '4px 8px',
              background: 'transparent',
              border: 'none',
              color: theme.fgMuted,
              cursor: 'pointer',
              'font-size': '18px',
              'line-height': '1',
            }}
          >
            ×
          </button>
        </Show>
      </div>
      {props.children}
      <Show when={props.footer}>{props.footer}</Show>
    </Dialog>
  );
}

/** Standard footer container — flex-end, 8px gap, matches every existing dialog. */
export function DialogFooter(props: { children: JSX.Element }) {
  return (
    <div
      style={{
        display: 'flex',
        gap: '8px',
        'justify-content': 'flex-end',
        'padding-top': '4px',
      }}
    >
      {props.children}
    </div>
  );
}

export interface DialogCancelButtonProps {
  onClick: () => void;
  label?: string;
  disabled?: boolean;
  ref?: HTMLButtonElement | ((el: HTMLButtonElement) => void);
}

/** Standard "Cancel" button matching the existing inline styling. */
export function DialogCancelButton(props: DialogCancelButtonProps) {
  return (
    <button
      ref={props.ref}
      type="button"
      class="btn-secondary"
      onClick={() => props.onClick()}
      disabled={props.disabled}
      style={{
        padding: '9px 18px',
        background: theme.bgInput,
        border: `1px solid ${theme.border}`,
        'border-radius': '8px',
        color: theme.fgMuted,
        cursor: props.disabled ? 'not-allowed' : 'pointer',
        'font-size': '14px',
      }}
    >
      {props.label ?? 'Cancel'}
    </button>
  );
}

export interface DialogPrimaryButtonProps {
  onClick: () => void;
  label: string;
  disabled?: boolean;
  loading?: boolean;
  /** Render as a destructive (red) action instead of the accent colour. */
  danger?: boolean;
}

/** Standard primary action button matching the existing inline styling. */
export function DialogPrimaryButton(props: DialogPrimaryButtonProps) {
  return (
    <button
      type="button"
      class={props.danger ? 'btn-danger' : 'btn-primary'}
      disabled={props.disabled}
      onClick={() => props.onClick()}
      style={{
        padding: '9px 20px',
        background: props.danger ? theme.error : theme.accent,
        border: 'none',
        'border-radius': '8px',
        color: props.danger ? '#fff' : theme.accentText,
        cursor: props.disabled ? 'not-allowed' : 'pointer',
        'font-size': '14px',
        'font-weight': '500',
        opacity: props.disabled ? '0.5' : '1',
        display: 'inline-flex',
        'align-items': 'center',
        gap: '8px',
      }}
    >
      <Show when={props.loading}>
        <span class="inline-spinner" aria-hidden="true" />
      </Show>
      {props.label}
    </button>
  );
}

/**
 * Wires Enter inside form fields (single-line `<input>`s and the explicit
 * `data-dialog-field` selector) under `formRef` to advance focus to the
 * next field. ArrowDown does the same; ArrowUp goes back. Skips disabled
 * elements. Reserved for future dialog migrations — not yet used.
 *
 * `formRef` is passed as a Solid Accessor (i.e. `() => HTMLElement | undefined`)
 * so the hook can wait until the panel has actually mounted.
 */
export function useDialogFieldNav(formRef: Accessor<HTMLElement | undefined>): void {
  createEffect(() => {
    const root = formRef();
    if (!root) return;

    const listener = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null;
      if (!target || !root.contains(target)) return;
      // Don't intercept inside multi-line textareas — Enter is meaningful there.
      const tag = target.tagName;
      const isMultiline = tag === 'TEXTAREA';
      if (e.key === 'Enter' && isMultiline) return;
      if (e.key !== 'Enter' && e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;

      const focusables = Array.from(
        root.querySelectorAll<HTMLElement>(
          'input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [data-dialog-field]:not([disabled])',
        ),
      );
      const idx = focusables.indexOf(target);
      if (idx < 0) return;

      const dir = e.key === 'ArrowUp' ? -1 : 1;
      const next = focusables[idx + dir];
      if (next) {
        e.preventDefault();
        next.focus();
        if ('select' in next && typeof (next as HTMLInputElement).select === 'function') {
          try {
            (next as HTMLInputElement).select();
          } catch {
            // Some <input type=…> reject .select() — non-fatal, just don't.
          }
        }
      }
    };

    root.addEventListener('keydown', listener);
    onCleanup(() => root.removeEventListener('keydown', listener));
  });
}
