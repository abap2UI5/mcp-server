/*
 * report-issue — report_issue: a GitHub issue DRAFTED for the user to file.
 *
 * WHY: an agent that finds a defect in the framework or in this server works
 * around it and moves on; nothing told it that a report is wanted, or made
 * one cheap. This tool makes it one call - and files nothing. It answers a
 * link that opens the repository's new-issue form with the fields filled in
 * (GitHub fills an issue form's fields from query parameters named by the
 * field ids, a plain issue from `title` and `body`), the same text as
 * markdown, and the open issues that look like the same problem, so a known
 * one gets a comment instead of a twin. The user reads it and presses the
 * button: no token, no account of ours, nothing posted in their name unseen.
 *
 * The search is GitHub's public issue search, unauthenticated (rate-limited
 * per IP); offline (A2UI5_MCP_OFFLINE / A2UI5_MCP_REMOTE=0) or unreachable,
 * the draft goes out without it and says so.
 */

export const ISSUE_REPOS = {
  'abap2UI5': { owner: 'abap2UI5', name: 'abap2UI5', template: 'bug_report.yml' },
  'mcp-server': { owner: 'abap2UI5', name: 'mcp-server', template: 'bug_report.yml' },
  'docs': { owner: 'abap2UI5', name: 'docs', template: 'bug_report.yml' },
  'app-template': { owner: 'abap2UI5', name: 'app-template', template: 'bug_report.yml' },
  'samples': { owner: 'abap2UI5', name: 'samples', template: null },
  'samples-controls': { owner: 'abap2UI5', name: 'samples-controls', template: null },
  'samples-stack': { owner: 'abap2UI5', name: 'samples-stack', template: null },
};

/* A link longer than this is cut by browsers and by GitHub; the body is
 * shortened first, with a note to paste the rest from the markdown. */
export const MAX_URL = 7500;

const FOUND_BY = 'An AI assistant through the abap2UI5 MCP server (report_issue); filed by its user after reading it.';

/** The issue as markdown - what the link carries, and what the user can paste. Pure. */
export function issueMarkdown({ whatHappened, reproduction, version, environment }) {
  const parts = [`### What happened?\n\n${whatHappened.trim()}`];
  if (reproduction && reproduction.trim()) parts.push(`### How to reproduce\n\n\`\`\`abap\n${reproduction.trim()}\n\`\`\``);
  if (version) parts.push(`### Version\n\n${version.trim()}`);
  if (environment) parts.push(`### Environment\n\n${environment.trim()}`);
  parts.push(`### Found by\n\n${FOUND_BY}`);
  return parts.join('\n\n') + '\n';
}

/**
 * The new-issue link. With an issue form (`template`), each field by its id -
 * the ids bug_report.yml uses in abap2UI5 (description, reproduction,
 * version, environment, context; the same in the other repositories' forms);
 * without one, `title` and `body`. Too long: the reproduction is left out of
 * the link and `cut` says so. Pure.
 */
export function issueUrl(repo, fields) {
  const r = ISSUE_REPOS[repo];
  const base = `https://github.com/${r.owner}/${r.name}/issues/new`;
  const build = (withRepro) => {
    const q = new URLSearchParams();
    if (r.template) {
      q.set('template', r.template);
      q.set('title', fields.title);
      q.set('description', fields.whatHappened);
      if (withRepro && fields.reproduction) q.set('reproduction', fields.reproduction);
      if (fields.version) q.set('version', fields.version);
      if (fields.environment) q.set('environment', fields.environment);
      q.set('context', FOUND_BY + (withRepro || !fields.reproduction ? '' : ' The reproduction did not fit the link - paste it from the draft.'));
    } else {
      q.set('title', fields.title);
      q.set('body', issueMarkdown(withRepro ? fields : { ...fields, reproduction: fields.reproduction ? '(too long for the link - paste it from the draft)' : '' }));
    }
    return `${base}?${q.toString()}`;
  };
  const full = build(true);
  if (full.length <= MAX_URL) return { url: full, cut: false };
  return { url: build(false), cut: true };
}

/** Search words out of a title: the longer words, at most six. Pure. */
export function searchTerms(title) {
  const words = String(title || '').toLowerCase().match(/[a-z0-9_]{4,}/g) || [];
  return [...new Set(words)].slice(0, 6);
}

/**
 * The open issues of the repository whose title or body carries the title's
 * words: [{ number, title, url }], at most five, or { error } when the search
 * could not run. `fetchImpl` is injected by the tests.
 */
export async function similarIssues(repo, title, { fetchImpl = globalThis.fetch, env = process.env, timeoutMs = 8000 } = {}) {
  if (env.A2UI5_MCP_OFFLINE || env.A2UI5_MCP_REMOTE === '0') return { error: 'offline (A2UI5_MCP_OFFLINE / A2UI5_MCP_REMOTE=0) - search the issues by hand before filing' };
  const r = ISSUE_REPOS[repo];
  const terms = searchTerms(title);
  if (!terms.length) return { issues: [] };
  const q = `repo:${r.owner}/${r.name} is:issue is:open ${terms.join(' ')}`;
  try {
    const res = await fetchImpl(`https://api.github.com/search/issues?per_page=5&q=${encodeURIComponent(q)}`, {
      headers: { accept: 'application/vnd.github+json', 'user-agent': 'abap2ui5-mcp-server' },
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) return { error: `the GitHub search answered ${res.status} - search the issues by hand before filing` };
    const data = await res.json();
    return {
      issues: (data.items || []).slice(0, 5).map((i) => ({ number: i.number, title: i.title, url: i.html_url })),
    };
  } catch (e) {
    return { error: `the GitHub search could not run (${(e && e.message) || e}) - search the issues by hand before filing` };
  }
}
