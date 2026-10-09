// The loader hook of guard-probe.mjs: lib/budget.mjs is loaded with one
// statement appended that rebinds its own guardAnswer (a function
// declaration is a mutable binding, and an ES import is a live view of it -
// server.mjs calls the wrapped one) to the original plus a `_meta` mark.
export const PROBE_MARK = 'abap2ui5-test/guarded';

export async function load(url, context, nextLoad) {
  const loaded = await nextLoad(url, context);
  if (!url.endsWith('/lib/budget.mjs')) return loaded;
  const source = `${String(loaded.source)}
const __guardProbeOriginal = guardAnswer;
guardAnswer = function guardAnswerProbe(result, ...rest) {
  const out = __guardProbeOriginal(result, ...rest);
  if (out && typeof out === 'object') out._meta = { ...(out._meta || {}), ${JSON.stringify(PROBE_MARK)}: true };
  return out;
};
`;
  return { ...loaded, source };
}
