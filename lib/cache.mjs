/*
 * cache — parse a file once per version of the file.
 *
 * Every document this server serves is read LIVE from a sibling checkout, on
 * every query, so nothing generated can drift (the contract every parser
 * module states). The cost of that contract was re-parsing an unchanged file
 * on every call: the whole docs tree per docs_search, three catalogues per
 * examples query, the client interface per api_reference call.
 *
 * This keeps the contract and drops the cost: a parse is cached under
 * (path, mtimeMs, size), so an edited or pulled file invalidates itself the
 * moment it changes on disk — what the agent sees is still always what the
 * checkout says, and an unchanged file costs one stat instead of a read and
 * a parse. Deliberately no TTL and no manual invalidation: the file's own
 * identity is the key, the way the "live read" doctrine wants it.
 *
 * Nothing is cached for a file that cannot be statted — the caller keeps its
 * own existsSync / null-return semantics, exactly as before.
 *
 * The key is the PATH, so two readers that parse one file differently must
 * not share it: `identified()` in lib/repos.mjs wants samples' catalogue.json
 * as plain JSON while `readCatalogue` in lib/examples.mjs wants it as entries,
 * and the second caller used to be handed the first one's value. A reader
 * whose parse is not "the" parse of that file names a `scope` of its own.
 */
import fs from 'fs';

const cache = new Map();

/**
 * `make(file)` once per (path, mtimeMs, size); the cached value afterwards.
 * `make` may return a promise — it is cached like any value, so a loader that
 * must never reject should catch inside. Throws what fs.statSync throws when
 * the file is absent (callers check existence first, as they always did).
 * `scope` separates readers that parse the same file differently.
 */
export function fileKeyed(file, make, scope = '') {
  const st = fs.statSync(file);
  const key = scope ? `${scope}\0${file}` : file;
  const hit = cache.get(key);
  if (hit && hit.mtimeMs === st.mtimeMs && hit.size === st.size) return hit.value;
  const value = make(file);
  cache.set(key, { mtimeMs: st.mtimeMs, size: st.size, value });
  return value;
}

/** `parse(text, file)` over the file's utf8 content, cached the same way. */
export function readCached(file, parse, scope = '') {
  return fileKeyed(file, (f) => parse(fs.readFileSync(f, 'utf8'), f), scope);
}

/** Test hook: forget everything (a fresh process in miniature). */
export function clearCache() {
  cache.clear();
}
