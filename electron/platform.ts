import { execFileSync } from 'child_process';
import { promisify } from 'util';
import { execFile } from 'child_process';
import * as os from 'os';
import * as path from 'path';

const execFileAsync = promisify(execFile);

export const IS_WINDOWS = process.platform === 'win32';

/** Cross-platform PATH resolver. Throws if command not found. */
export function validateCommandOnPath(command: string): void {
  const tool = IS_WINDOWS ? 'where.exe' : 'which';
  try {
    execFileSync(tool, [command], { encoding: 'utf8', timeout: 3000 });
  } catch {
    throw new Error(
      `Command '${command}' not found in PATH. Make sure it is installed and available in your terminal.`,
    );
  }
}

/** Async variant. Returns true if the binary is resolvable on PATH or at an absolute path. */
export async function isCommandOnPath(command: string): Promise<boolean> {
  if (isAbsolutePath(command)) {
    try {
      const fs = await import('fs');
      await fs.promises.access(command, fs.constants.F_OK);
      return true;
    } catch {
      return false;
    }
  }
  const tool = IS_WINDOWS ? 'where.exe' : 'which';
  try {
    await execFileAsync(tool, [command], { encoding: 'utf8', timeout: 3000 });
    return true;
  } catch {
    return false;
  }
}

/** True for `/unix/path`, `C:\windows`, `C:/mixed`, or `\\server\share`. */
export function isAbsolutePath(p: string): boolean {
  return path.isAbsolute(p);
}

/** Prefer os.homedir() over HOME/USERPROFILE env — works on both platforms. */
export function homeDir(): string {
  return os.homedir();
}

/**
 * Shell metachar guard. Windows paths routinely contain `()` (e.g. Program Files (x86))
 * and `&` is rare but possible. For absolute paths we trust them; for bare names we block
 * everything dangerous on either shell.
 */
export function containsShellMetachars(command: string): boolean {
  if (isAbsolutePath(command)) {
    return /[;|`$\n]/.test(command);
  }
  return /[;&|`$(){}\n]/.test(command);
}
