import { Show, createEffect, createSignal, onCleanup } from 'solid-js';
import { pushTask } from '../store/store';
import { Channel } from '../lib/ipc';
import { DialogShell, DialogFooter, DialogCancelButton, DialogPrimaryButton } from './DialogShell';
import { theme, bannerStyle } from '../lib/theme';
import type { Task } from '../store/types';

interface PushDialogProps {
  open: boolean;
  task: Task;
  onStart: () => void;
  onClose: () => void;
  onDone: (success: boolean) => void;
}

export function PushDialog(props: PushDialogProps) {
  const [pushError, setPushError] = createSignal('');
  const [pushing, setPushing] = createSignal(false);
  const [output, setOutput] = createSignal('');
  let channel: Channel<string> | null = null;
  let outputRef: HTMLPreElement | undefined;

  // Reset stale state when dialog re-opens
  createEffect(() => {
    if (props.open && !pushing()) {
      setPushError('');
      setOutput('');
    }
  });

  onCleanup(() => {
    channel?.cleanup?.();
    channel = null;
  });

  function startPush() {
    const taskId = props.task.id;
    const onDone = props.onDone;

    channel?.cleanup?.();
    setPushError('');
    setPushing(true);
    setOutput('');

    channel = new Channel<string>();
    channel.onmessage = (text) => {
      setOutput((prev) => prev + text);
      // Auto-scroll to bottom
      requestAnimationFrame(() => {
        if (outputRef) outputRef.scrollTop = outputRef.scrollHeight;
      });
    };

    props.onStart();

    void pushTask(taskId, channel)
      .then(() => {
        onDone(true);
      })
      .catch((err) => {
        setPushError(String(err));
        onDone(false);
      })
      .finally(() => {
        setPushing(false);
        channel?.cleanup?.();
        channel = null;
      });
  }

  return (
    <DialogShell
      open={props.open}
      title="Push to Remote"
      width="480px"
      onClose={() => (pushing() ? props.onClose() : props.onDone(false))}
      footer={
        <DialogFooter>
          <DialogCancelButton
            onClick={() => {
              if (pushing()) {
                props.onClose();
              } else {
                props.onDone(false);
                setPushError('');
                setOutput('');
              }
            }}
            label={pushing() ? 'Close' : 'Cancel'}
          />
          <Show when={!pushing()}>
            <DialogPrimaryButton onClick={startPush} label="Push" />
          </Show>
        </DialogFooter>
      }
    >
      <div style={{ 'font-size': '14px', color: theme.fgMuted, 'line-height': '1.5' }}>
        <Show
          when={pushing() || output()}
          fallback={
            <p style={{ margin: '0' }}>
              Push branch <strong>{props.task.branchName}</strong> to remote?
            </p>
          }
        >
          <pre
            ref={outputRef}
            style={{
              margin: '0',
              'font-family': "'JetBrains Mono', monospace",
              'font-size': '12px',
              'line-height': '1.5',
              'white-space': 'pre-wrap',
              'word-break': 'break-all',
              padding: '8px 12px',
              'max-height': '200px',
              'overflow-y': 'auto',
              background: theme.bgInput,
              'border-radius': '8px',
              border: `1px solid ${theme.border}`,
              color: theme.fgMuted,
            }}
          >
            {output() || 'Pushing...'}
          </pre>
        </Show>
        <Show when={pushError()}>
          <div
            style={{
              ...bannerStyle(theme.error),
              'margin-top': '12px',
              'font-size': '13px',
            }}
          >
            {pushError()}
          </div>
        </Show>
      </div>
    </DialogShell>
  );
}
