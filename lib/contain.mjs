/*
 * contain - reads and writes that stay inside the directory they belong to.
 *
 * A checkout is untrusted content: a sample, docs or template repository
 * cloned from GitHub, a sandbox an earlier deploy filled. The path checks
 * (`safeRelPath` in lib/remote.mjs, the sandbox's class-name gate) stop a
 * `..` or an absolute path in a STRING. A symbolic link the repository
 * itself ships is the other half: `docs/agents/building-apps.md ->
 * ~/.ssh/id_rsa` in a checkout would hand the file to the agent as the guide,
 * `zz_dev/zcl_x.clas.abap -> ~/.bashrc` would have a deploy overwrite it.
 * Every read of a checkout file a tool answers with, and every write into a
 * directory a checkout can hold links in, goes through here.
 *
 * Which checkouts count as untrusted, and which are trusted because their
 * code runs anyway, is SECURITY.md's; this module only answers "inside or
 * not". A leaf - fs and path only - so every reader can import it.
 */
import fs from 'fs';
import path from 'path';

const lexists = (p) => {
  try {
    fs.lstatSync(p);
    return true;
  } catch {
    return false;
  }
};

/**
 * Whether `target` - with EVERY symbolic link on its path resolved - stays
 * inside `root`. For a path that does not exist yet (a file about to be
 * written) the nearest existing ancestor is resolved instead, so a symlinked
 * parent directory is caught before the write - and a DANGLING link on the
 * way is never inside: writing through `box/x -> /elsewhere/new` creates
 * /elsewhere/new, wherever the link points (realpath cannot follow it, and
 * the parent of the link resolving inside said nothing about its target).
 * Both `root` and `target` are absolute. False on any error - an
 * unresolvable path is not inside.
 */
export function resolvedInside(root, target) {
  try {
    const realRoot = fs.realpathSync(root);
    let real;
    try {
      real = fs.realpathSync(target);
    } catch {
      let at = path.resolve(target);
      while (at !== path.dirname(at) && !lexists(at)) at = path.dirname(at);
      if (fs.lstatSync(at).isSymbolicLink()) return false; // exists for lstat, not for realpath: a dangling link
      real = path.join(fs.realpathSync(at), path.relative(at, path.resolve(target)));
    }
    return real === realRoot || real.startsWith(realRoot + path.sep);
  } catch {
    return false;
  }
}

/** Raised for a path that leaves its root through a symbolic link. */
export class OutsideRootError extends Error {}

/**
 * `path.join(root, ...rel)` - when it stays inside `root` with every link
 * resolved (resolvedInside); an OutsideRootError naming both otherwise.
 * `what` names the root in the message ("the abap2UI5 checkout").
 */
export function insideRoot(root, rel, what = 'the checkout') {
  const at = path.join(root, ...[].concat(rel));
  if (!resolvedInside(root, at)) {
    throw new OutsideRootError(`refusing ${at} - it resolves, through a symbolic link, outside ${what} at ${root}; `
      + 'a file a repository ships as a link out of itself is never read or written');
  }
  return at;
}

/** The text (or bytes, without `encoding`) of `rel` inside `root`, refused
 *  when it leaves the root (insideRoot). */
export function readInside(root, rel, encoding, what) {
  return fs.readFileSync(insideRoot(root, rel, what), encoding);
}

/**
 * fs.writeFileSync that never writes THROUGH a symbolic link in the last
 * component: opened with O_NOFOLLOW, so the check and the write are one
 * system call - a link put there after a resolvedInside check (or a dangling
 * one) fails the open with ELOOP instead of redirecting the write. Windows
 * has no O_NOFOLLOW: an lstat check right before the open stands in there.
 * The directories above are the caller's to have checked (resolvedInside).
 */
export function writeNoFollow(file, data) {
  const nofollow = fs.constants.O_NOFOLLOW;
  if (!nofollow && lexists(file) && fs.lstatSync(file).isSymbolicLink()) {
    throw new OutsideRootError(`refusing to write ${file} - it is a symbolic link`);
  }
  let fd;
  try {
    fd = fs.openSync(file, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_TRUNC | (nofollow || 0), 0o666);
  } catch (e) {
    if (e && e.code === 'ELOOP') throw new OutsideRootError(`refusing to write ${file} - it is a symbolic link`);
    throw e;
  }
  try {
    fs.writeFileSync(fd, data);
  } finally {
    fs.closeSync(fd);
  }
}

/** writeNoFollow into `root`: the directories above checked, the last
 *  component never followed. Returns the path written. */
export function writeInside(root, rel, data, what) {
  const at = insideRoot(root, rel, what);
  writeNoFollow(at, data);
  return at;
}
