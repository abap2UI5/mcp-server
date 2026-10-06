/*
 * private-dir - a directory of this user's own under the shared OS temp dir.
 *
 * Two defaults sit directly under os.tmpdir() by a fixed name: the GitHub
 * mirror (`<tmp>/abap2ui5-mcp-remote`, lib/remote.mjs) and the screenshots
 * and build log of run_app and interact_app (`<tmp>/abap2ui5-mcp-screenshots`,
 * lib/runtime.mjs). On Linux that is /tmp, which every local user can write,
 * so the first user to create the name owns it - or plants a symbolic link
 * of that name. The server used to take whatever it found there: another
 * user decided what the mirror served (the guide the agent follows, the
 * template.json whose files add_agent_setup writes into the user's project),
 * read the screenshots of the user's apps, and steered the mirror's writes
 * and removals, the PNGs and the build log through links into the user's
 * own files.
 *
 * So such a default is used only when it is a real directory (no link),
 * owned by the user running the server and writable by nobody else. It is
 * created 0700, and one of ours that others can read is narrowed to 0700.
 * Anything else is refused with the reason, and the caller names the env var
 * that puts the directory somewhere else. A directory an env var names is
 * the user's own choice and is not checked here. Windows keeps its temp dir
 * per user and has no uid or mode bits: only the link check applies there.
 */
import fs from 'fs';

const currentUid = () => (typeof process.getuid === 'function' ? process.getuid() : undefined);

/**
 * Why `dir` must not be used as this user's private directory, or null when
 * it may. `create` makes it (0700) when it is absent; without it an absent
 * directory is no problem - there is nothing in it to distrust. `uid` and
 * `platform` are parameters for the tests.
 */
export function privateDirProblem(dir, { create = false, uid = currentUid(), platform = process.platform } = {}) {
  if (create) {
    try {
      fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    } catch (e) {
      return `${dir} cannot be created (${(e && e.code) || e})`;
    }
  }
  let st;
  try {
    st = fs.lstatSync(dir);
  } catch (e) {
    if (e && e.code === 'ENOENT') return null;
    return `${dir} cannot be inspected (${(e && e.code) || e})`;
  }
  if (st.isSymbolicLink()) return `${dir} is a symbolic link, not a directory of this user's own`;
  if (!st.isDirectory()) return `${dir} is not a directory`;
  if (platform === 'win32') return null;
  if (uid !== undefined && st.uid !== uid) return `${dir} belongs to another user (uid ${st.uid}), not to this one (uid ${uid})`;
  if (st.mode & 0o002) return `${dir} is writable by every user (mode ${(st.mode & 0o777).toString(8)}) - remove it`;
  if (st.mode & 0o077) {
    try {
      fs.chmodSync(dir, 0o700);
    } catch (e) {
      return `${dir} is open to other users (mode ${(st.mode & 0o777).toString(8)}) and cannot be narrowed to 0700 (${(e && e.code) || e})`;
    }
  }
  return null;
}
