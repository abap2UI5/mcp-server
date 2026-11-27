// report_issue drafts, never posts: the link, the markdown and the search are
// pure or injected - no network in this test.
import test from 'node:test';
import assert from 'node:assert/strict';
import { issueUrl, issueMarkdown, searchTerms, similarIssues, MAX_URL, ISSUE_REPOS } from '../lib/report-issue.mjs';

const FIELDS = {
  title: 'popup_display: a second popup closes the first',
  whatHappened: 'Opening a popup from a popup closes the first one. Expected: both stacked.',
  reproduction: 'CLASS zcl_repro DEFINITION PUBLIC.\n  PUBLIC SECTION.\n    INTERFACES z2ui5_if_app.\nENDCLASS.',
  version: '1.151.0',
  environment: 'local npm backend',
};

test('an issue form gets its fields by id; a repository without one gets title and body', () => {
  const { url, cut } = issueUrl('abap2UI5', FIELDS);
  assert.equal(cut, false);
  const u = new URL(url);
  assert.equal(u.origin + u.pathname, 'https://github.com/abap2UI5/abap2UI5/issues/new');
  assert.equal(u.searchParams.get('template'), 'bug_report.yml');
  assert.equal(u.searchParams.get('description'), FIELDS.whatHappened);
  assert.equal(u.searchParams.get('reproduction'), FIELDS.reproduction);
  assert.equal(u.searchParams.get('version'), '1.151.0');
  assert.match(u.searchParams.get('context'), /AI assistant/);
  const plain = new URL(issueUrl('samples', FIELDS).url);
  assert.equal(plain.searchParams.get('template'), null);
  assert.match(plain.searchParams.get('body'), /### How to reproduce\n\n```abap\nCLASS zcl_repro/);
});

test('a reproduction too long for a link is left out of it, and the answer says so', () => {
  const long = { ...FIELDS, reproduction: 'x'.repeat(MAX_URL) };
  const { url, cut } = issueUrl('abap2UI5', long);
  assert.equal(cut, true);
  assert.ok(url.length <= MAX_URL, `link of ${url.length}`);
  assert.match(new URL(url).searchParams.get('context'), /did not fit the link/);
});

test('the markdown names every section given, and who found it', () => {
  const md = issueMarkdown(FIELDS);
  for (const h of ['What happened?', 'How to reproduce', 'Version', 'Environment', 'Found by']) assert.match(md, new RegExp(`### ${h}`));
  assert.doesNotMatch(issueMarkdown({ whatHappened: 'x' }), /How to reproduce/);
});

test('the search: the title\'s longer words in the repository\'s open issues; offline or failing, a sentence', async () => {
  assert.deepEqual(searchTerms('popup_display: a second popup closes'), ['popup_display', 'second', 'popup', 'closes']);
  let asked = null;
  const fetchImpl = async (url) => {
    asked = decodeURIComponent(url);
    return { ok: true, json: async () => ({ items: [{ number: 7, title: 'popups close', html_url: 'https://github.com/abap2UI5/abap2UI5/issues/7' }] }) };
  };
  const hit = await similarIssues('abap2UI5', FIELDS.title, { fetchImpl, env: {} });
  assert.deepEqual(hit.issues, [{ number: 7, title: 'popups close', url: 'https://github.com/abap2UI5/abap2UI5/issues/7' }]);
  assert.match(asked, /repo:abap2UI5\/abap2UI5 is:issue is:open popup_display/);
  assert.match((await similarIssues('abap2UI5', 'x y', { fetchImpl, env: { A2UI5_MCP_OFFLINE: '1' } })).error, /offline/);
  assert.match((await similarIssues('abap2UI5', FIELDS.title, { fetchImpl: async () => ({ ok: false, status: 403 }), env: {} })).error, /403/);
  assert.match((await similarIssues('abap2UI5', FIELDS.title, { fetchImpl: async () => { throw new Error('ENOTFOUND'); }, env: {} })).error, /ENOTFOUND/);
});

test('every repository it drafts for is one of the organisation\'s', () => {
  for (const r of Object.values(ISSUE_REPOS)) assert.equal(r.owner, 'abap2UI5');
});
