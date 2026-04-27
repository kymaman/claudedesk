import { createEffect, type JSX } from 'solid-js';
import { DialogShell, DialogFooter, DialogCancelButton, DialogPrimaryButton } from './DialogShell';
import { theme } from '../lib/theme';

interface ConfirmDialogProps {
  open: boolean;
  title: string;
  message: string | JSX.Element;
  confirmLabel?: string;
  cancelLabel?: string;
  confirmLoading?: boolean;
  danger?: boolean;
  confirmDisabled?: boolean;
  autoFocusCancel?: boolean;
  width?: string;
  onConfirm: () => void;
  onCancel: () => void;
}

export function ConfirmDialog(props: ConfirmDialogProps) {
  let cancelRef: HTMLButtonElement | undefined;

  // Auto-focus the cancel button (or let Dialog's panel get focus)
  createEffect(() => {
    if (!props.open) return;
    const focusCancelBtn = props.autoFocusCancel ?? true;

    // Blur whatever is focused outside the dialog (e.g. the button that
    // triggered this dialog) so our programmatic focus call sticks.
    (document.activeElement as HTMLElement)?.blur?.();

    // Focus the cancel button after the Dialog panel renders.
    requestAnimationFrame(() => {
      if (focusCancelBtn) cancelRef?.focus();
    });
  });

  return (
    <DialogShell
      open={props.open}
      title={props.title}
      onClose={props.onCancel}
      {...(props.width !== undefined ? { width: props.width } : {})}
      footer={
        <DialogFooter>
          <DialogCancelButton
            ref={(el) => {
              cancelRef = el;
            }}
            onClick={props.onCancel}
            label={props.cancelLabel ?? 'Cancel'}
          />
          <DialogPrimaryButton
            onClick={props.onConfirm}
            label={props.confirmLabel ?? 'Confirm'}
            {...(props.confirmDisabled !== undefined ? { disabled: props.confirmDisabled } : {})}
            {...(props.confirmLoading !== undefined ? { loading: props.confirmLoading } : {})}
            {...(props.danger !== undefined ? { danger: props.danger } : {})}
          />
        </DialogFooter>
      }
    >
      <div style={{ 'font-size': '14px', color: theme.fgMuted, 'line-height': '1.5' }}>
        {props.message}
      </div>
    </DialogShell>
  );
}
