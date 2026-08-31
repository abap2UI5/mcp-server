/*
 * The repo-wide ASCII rule, as a gate.
 *
 * AGENTS.md makes it a hard rule ("no non-ASCII LITERAL goes in a source
 * file") and lib/capabilities.mjs bends around it: the CAPABILITIES.md status
 * marks are built with String.fromCodePoint so that a parser's data can never
 * depend on how an editor saved a glyph. Nothing checked it. A rule that costs
 * a contributor a `String.fromCodePoint` and lets the next paste of a literal
 * emoji through is not a rule, it is a habit.
 *
 * What the rule actually says, in AGENTS.md's own words, is narrower than
 * "7-bit ASCII", which no file in this repo has ever been: PROSE is a
 * different matter, and comments and tool descriptions have always used em
 * dashes. So the gate allows the punctuation this project's prose is written
 * with, by code point, and refuses everything else - emoji, symbols, invisible
 * characters, and the homoglyph letters that make two identifiers look
 * identical and compare unequal.
 *
 * The allowed set is deliberately tiny and deliberately not "all punctuation":
 * every addition to it is a decision somebody makes once, in this file, rather
 * than a character that arrived with a paste.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

/** Prose punctuation this project writes with. Nothing else is allowed. */
const ALLOWED = new Map([
  [0x2014, 'em dash - the punctuation every description and comment here uses'],
  [0x2013, 'en dash - a range, in the same prose'],
  [0x00a7, 'section sign - cites a numbered section of another AGENTS.md'],
]);

const SOURCES = [
  'server.mjs',
  ...fs.readdirSync(path.join(ROOT, 'lib')).filter((f) => f.endsWith('.mjs')).map((f) => `lib/${f}`),
];

test('every source file is ASCII apart from the prose punctuation the rule allows', () => {
  for (const file of SOURCES) {
    const text = fs.readFileSync(path.join(ROOT, file), 'utf8');
    const lines = text.split('\n');
    for (let i = 0; i < lines.length; i++) {
      for (const ch of lines[i]) {
        const cp = ch.codePointAt(0);
        if (cp < 128 || ALLOWED.has(cp)) continue;
        assert.fail(
          `${file}:${i + 1} carries U+${cp.toString(16).toUpperCase().padStart(4, '0')} `
          + `(${JSON.stringify(ch)}): ${lines[i].trim().slice(0, 80)}\n`
          + 'AGENTS.md: no non-ASCII literal in a source file - build the character from its '
          + 'code point (String.fromCodePoint, the way lib/capabilities.mjs builds the '
          + 'CAPABILITIES.md status marks), or use the ASCII spelling. If it is prose '
          + 'punctuation this project should be allowed to write with, add it to ALLOWED in '
          + 'test/ascii.test.mjs with the reason.',
        );
      }
    }
  }
});

/* The gate has to be able to FAIL, and the characters it exists for are
 * exactly the ones nobody would type on purpose: the status mark
 * lib/capabilities.mjs goes out of its way to build from a code point, and a
 * zero-width space, which is invisible in every editor and every diff. */
test('the ASCII gate rejects the characters it exists for', () => {
  const offenders = [0x2705, 0x1f536, 0x200b, 0x00e9, 0x0410];
  for (const cp of offenders) {
    assert.equal(ALLOWED.has(cp), false,
      `U+${cp.toString(16).toUpperCase()} must not be allowed - it is data or invisible, not prose punctuation`);
    assert.ok(String.fromCodePoint(cp).codePointAt(0) > 127);
  }
  // and the ones it allows are allowed on purpose, each with its reason
  for (const [cp, why] of ALLOWED) {
    assert.ok(why.length > 10, `U+${cp.toString(16).toUpperCase()} needs a reason, not a label`);
  }
});
