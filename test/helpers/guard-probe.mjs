// Test-only preload (`node --import ./test/helpers/guard-probe.mjs server.mjs`):
// registers guard-probe-hooks.mjs, which marks every result guardAnswer
// returns. test/answer-guard.test.mjs then asserts that EVERY tools/call
// answer carries the mark - an answer that reached the client without
// passing the backstop has none. Nothing in the server knows about it.
import { register } from 'node:module';

register('./guard-probe-hooks.mjs', import.meta.url);
