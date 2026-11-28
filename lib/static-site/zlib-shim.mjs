// Node's zlib for the static build - the synchronous functions open-abap's
// cl_abap_gzip calls (gzipSync, gunzipSync, deflateRawSync, inflateRawSync,
// and their zlib-framed twins), computed by pako. Resolved to nothing, as a
// plain browser bundle does, every compress or decompress of an app was
// "zlib.gzipSync is not a function".
import { Buffer } from 'buffer';
import * as pako from 'pako';

const wrap = (fn) => (data, options = {}) => Buffer.from(fn(data instanceof Uint8Array ? data : Buffer.from(data), options.level === undefined ? {} : { level: options.level }));

export const gzipSync = wrap(pako.gzip);
export const gunzipSync = wrap(pako.ungzip);
export const deflateSync = wrap(pako.deflate);
export const inflateSync = wrap(pako.inflate);
export const deflateRawSync = wrap(pako.deflateRaw);
export const inflateRawSync = wrap(pako.inflateRaw);
export const constants = { Z_NO_FLUSH: 0, Z_PARTIAL_FLUSH: 1, Z_SYNC_FLUSH: 2, Z_FULL_FLUSH: 3, Z_FINISH: 4 };
export default { gzipSync, gunzipSync, deflateSync, inflateSync, deflateRawSync, inflateRawSync, constants };
