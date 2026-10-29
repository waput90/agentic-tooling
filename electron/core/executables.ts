import { access, realpath } from 'node:fs/promises';
import { delimiter, isAbsolute, join } from 'node:path';
// Search absolute PATH entries only. Windows process creation otherwise searches
// the untrusted repository CWD before PATH, allowing a repository git.exe to run.
export async function trustedExecutable(name: string): Promise<string> {
  if (isAbsolute(name)) return realpath(name);
  const extensions = process.platform === 'win32' ? ['.exe'] : [''];
  for (const directory of (process.env.PATH ?? process.env.Path ?? '').split(delimiter)) {
    if (!isAbsolute(directory)) continue;
    for (const ext of extensions) {
      const path = join(directory, name.endsWith(ext) ? name : name + ext);
      try {
        await access(path);
        return await realpath(path);
      } catch {}
    }
  }
  throw new Error(
    `${name} was not found on the system PATH. Install it and restart the application.`,
  );
}
