import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, realpath } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { safeEnvironment } from './policy';
import { trustedExecutable } from './executables';
const exec = promisify(execFile);
export async function git(root: string, args: string[]) {
  return (
    await exec(
      await trustedExecutable('git'),
      [
        '-c',
        `core.hooksPath=${process.platform === 'win32' ? 'NUL' : '/dev/null'}`,
        '-c',
        'core.fsmonitor=false',
        ...args,
      ],
      {
        cwd: root,
        windowsHide: true,
        env: { ...safeEnvironment(), GIT_TERMINAL_PROMPT: '0' },
        maxBuffer: 16 * 1024 * 1024,
      },
    )
  ).stdout.trim();
}
export async function repository(path: string) {
  const root = await realpath(await git(path, ['rev-parse', '--show-toplevel']));
  const commonDir = await realpath(
    resolve(root, await git(root, ['rev-parse', '--git-common-dir'])),
  );
  const branch = await git(root, ['rev-parse', '--abbrev-ref', 'HEAD']).catch(() => '(no commits)');
  return { root, commonDir, branch };
}
export async function baseline(root: string) {
  return git(root, ['rev-parse', 'HEAD']).catch(() => {
    throw new Error('Create an initial Git commit before planning or executing.');
  });
}
export async function worktree(root: string, path: string, base: string) {
  await mkdir(dirname(path), { recursive: true });
  await git(root, ['worktree', 'add', '--detach', path, base]);
}
export async function snapshotChanges(path: string) {
  await git(path, ['add', '--all']);
  const diff = await git(path, ['diff', '--cached', '--no-ext-diff', '--no-textconv']);
  if (diff)
    await git(path, [
      '-c',
      'user.name=Agentic Tooling',
      '-c',
      'user.email=agentic@localhost',
      '-c',
      'commit.gpgsign=false',
      'commit',
      '-m',
      'Agent task result',
    ]);
  return { diff, commit: await baseline(path) };
}
