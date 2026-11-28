// Node's crypto.createHash for the static build: every roundtrip hashes the
// model (cl_abap_message_digest, synchronously - WebCrypto's digest is a
// promise), so the hash is computed in JavaScript. randomUUID is left out on
// purpose: cl_system_uuid then takes window.crypto.randomUUID( ).
// (The recipe of abap2UI5/browser-demo, app/crypto-shim.mjs.)
import { Buffer } from 'buffer';
import { sha256, sha384, sha512 } from '@noble/hashes/sha2.js';
import { md5, sha1 } from '@noble/hashes/legacy.js';

const ALGORITHMS = { md5, sha1, sha256, sha384, sha512 };

export function createHash(algorithm) {
  const hash = ALGORITHMS[String(algorithm).toLowerCase().replace('-', '')];
  if (!hash) throw new Error(`crypto.createHash("${algorithm}") is not available in the static build (it knows ${Object.keys(ALGORITHMS).join(', ')})`);
  const state = hash.create();
  const api = {
    update(data, encoding) {
      state.update(typeof data === 'string' ? Buffer.from(data, encoding || 'utf8') : data);
      return api;
    },
    digest(encoding) {
      const out = Buffer.from(state.digest());
      return encoding ? out.toString(encoding) : out;
    },
  };
  return api;
}
export default { createHash };
