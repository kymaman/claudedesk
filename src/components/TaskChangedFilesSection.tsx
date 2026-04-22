import { Show, onMount } from 'solid-js';
import { setTaskFocusedPanel } from '../store/store';
import { ChangedFilesList } from './ChangedFilesList';
import { CommitNavBar } from './CommitNavBar';
import { theme } from '../lib/theme';
import { sf } from '../lib/fontScale';
import { useFocusRegistration } from '../lib/focus-registration';
import type { Task } from '../store/types';
import type { CommitInfo } from '../ipc/types';

interface TaskChangedFilesSectionProps {
  task: Task;
  isActive: boolean;
  commitList: CommitInfo[];
  selectedCommit: string | null;
  onCommitNavigate: (hash: string | null) => void;
  onDiffFileClick: (path: string) => void;
}

export function TaskChangedFilesSection(props: TaskChangedFilesSectionProps) {
  const selectedCommitInfo = () =>
    props.selectedCommit !== null && props.task.gitIsolation === 'worktree'
      ? props.commitList.find((c) => c.hash === props.selectedCommit)
      : undefined;

  let changedFilesRef: HTMLDivElement | undefined;

  onMount(() => {
    const id = props.task.id;
    useFocusRegistration(`${id}:changed-files`, () => {
      changedFilesRef?.focus();
    });
  });

  return (
    <div
      style={{
        height: '100%',
        background: theme.taskPanelBg,
        display: 'flex',
        'flex-direction': 'column',
      }}
      onClick={() => setTaskFocusedPanel(props.task.id, 'changed-files')}
    >
      <div
        style={{
          padding: '4px 8px',
          'font-size': sf(11),
          'font-weight': '600',
          color: theme.fgMuted,
          'text-transform': 'uppercase',
          'letter-spacing': '0.05em',
          'border-bottom': `1px solid ${theme.border}`,
          'flex-shrink': '0',
          display: 'flex',
          'align-items': 'center',
          gap: '6px',
        }}
      >
        <span style={{ 'flex-shrink': '0' }}>Changed Files</span>
        <span style={{ flex: '1' }} />
        <Show when={props.task.gitIsolation === 'worktree'}>
          <CommitNavBar
            commits={props.commitList}
            selectedCommitHash={props.selectedCommit}
            onNavigate={props.onCommitNavigate}
            compact={true}
          />
        </Show>
      </div>
      <Show when={selectedCommitInfo()}>
        {(commit) => (
          <div
            title={`${commit().hash.slice(0, 7)} ${commit().message}`}
            style={{
              padding: '4px 8px',
              'font-size': sf(11),
              'font-family': "'JetBrains Mono', monospace",
              color: theme.fgMuted,
              'border-bottom': `1px solid ${theme.border}`,
              'flex-shrink': '0',
              'white-space': 'nowrap',
              overflow: 'hidden',
              'text-overflow': 'ellipsis',
            }}
          >
            <span style={{ color: theme.accent, 'font-weight': '600' }}>
              {commit().hash.slice(0, 7)}
            </span>{' '}
            {commit().message}
          </div>
        )}
      </Show>
      <div style={{ flex: '1', overflow: 'hidden' }}>
        <ChangedFilesList
          worktreePath={props.task.worktreePath}
          baseBranch={props.task.baseBranch}
          isActive={props.isActive}
          selectedCommit={props.selectedCommit}
          onFileClick={(file) => props.onDiffFileClick(file.path)}
          ref={(el) => (changedFilesRef = el)}
        />
      </div>
    </div>
  );
}
