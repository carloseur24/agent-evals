/**
 * Runtime for the global `quick` agent.
 *
 * Registers two bounded retrieval tools and the circuit breakers that keep a
 * turn inside its wall-clock and step budget. This is an OpenCode V2 local
 * plugin: it default-exports { id, setup(ctx) } and imports nothing from the
 * OpenCode packages, so the symlinked directory loads without a build step.
 *
 * Knobs (environment):
 *   QUICK_AGENT_BUDGET_MS       wall-clock retrieval cutoff (default 18000)
 *   QUICK_AGENT_TOOL_TIMEOUT_MS per-network-call timeout (default 4000)
 *   QUICK_AGENT_FETCH_MAX_CHARS page text ceiling (default 4000)
 *   QUICK_AGENT_SEARCH_TTL_MS   docs cache TTL (default 24h)
 *   QUICK_AGENT_CLI_TTL_MS      CLI cache TTL (default 7d)
 */
import { createHash } from 'node:crypto';

const BUDGET_MS = numberFromEnv('QUICK_AGENT_BUDGET_MS', 18_000);
const TOOL_TIMEOUT_MS = numberFromEnv('QUICK_AGENT_TOOL_TIMEOUT_MS', 4_000);
const FETCH_MAX_CHARS = numberFromEnv('QUICK_AGENT_FETCH_MAX_CHARS', 4_000);
const SEARCH_TTL_MS = numberFromEnv('QUICK_AGENT_SEARCH_TTL_MS', 24 * 60 * 60 * 1000);
const CLI_TTL_MS = numberFromEnv('QUICK_AGENT_CLI_TTL_MS', 7 * 24 * 60 * 60 * 1000);
const MAX_RESULTS = 8;
const MAX_PAGE_BYTES = 2_000_000;
const AEO_SEARCH_MIN = numberFromEnv('QUICK_AGENT_AEO_MIN', 40);
const AEO_PAGE_MIN = numberFromEnv('QUICK_AGENT_AEO_PAGE_MIN', 25);
const CACHE_PREFIX = 'cache/';
const PLUGIN_ID = 'quick-agent';
const NETWORK_TOOLS = new Set(['fast_search', 'fast_fetch']);

const STOPWORDS = new Set([
  'a', 'an', 'the', 'in', 'on', 'of', 'for', 'to', 'how', 'do', 'does', 'did',
  'i', 'is', 'are', 'was', 'were', 'what', 'which', 'with', 'and', 'or', 'my',
  'your', 'it', 'this', 'that', 'from', 'using', 'use', 'can', 'should', 'would',
  'please', 'me', 'we', 'you',
]);

const PLACEHOLDERS = /\b(?:yyyy|yy|mm|dd|hh|ss)(?:[-_/](?:yyyy|yy|mm|dd|hh|ss))+\b|\b(?:yyyy|yy|mm|dd|hh|ss)\b/gi;

const OFFICIAL_HOSTS = new Set([
  'developer.mozilla.org',
  'docs.python.org',
  'nodejs.org',
  'react.dev',
  'typescriptlang.org',
  'go.dev',
  'rust-lang.org',
  'kubernetes.io',
  'git-scm.com',
  'man7.org',
  'gnu.org',
  'kernel.org',
  'postgresql.org',
  'dev.mysql.com',
  'mongodb.com',
  'redis.io',
  'sqlite.org',
  'php.net',
  'laravel.com',
  'djangoproject.com',
  'flask.palletsprojects.com',
  'fastapi.tiangolo.com',
  'pydantic.dev',
  'vuejs.org',
  'svelte.dev',
  'angular.io',
  'tailwindcss.com',
  'vitejs.dev',
  'webpack.js.org',
  'bun.sh',
  'deno.com',
  'npmjs.com',
  'pnpm.io',
  'yarnpkg.com',
  'w3.org',
  'ietf.org',
  'rfc-editor.org',
  'learn.microsoft.com',
  'docs.microsoft.com',
  'aws.amazon.com',
  'cloud.google.com',
]);

const DOCS_PATH = /(?:^|\/)(?:docs?|documentation|reference|api|manual|guides?|learn|faq|tutorials?|handbook)(?:\/|$)/i;
const ANSWER_FIRST = /^(?:use|run|set|call|add|install|create|define|configure|import|export|the\s+\w+\s+(?:is|are|returns|accepts)|to\s+\w+|in\s+\w+|you\s+can|you\s+should|start\s+by)/i;
const QUESTION = /^(?:how|what|why|when|where|which|who|can|does|do|is|are|should)\b/i;
const FORUM_HOST = /(?:^|\.)(?:stackoverflow\.com|stackexchange\.com|superuser\.com|serverfault\.com|reddit\.com|quora\.com)$/i;
const SECONDARY_HOST = /(?:^|\.)(?:geeksforgeeks\.org|javatpoint\.com|tutorialspoint\.com|w3schools\.com|medium\.com|dev\.to|hashnode\.com)$/i;

const CLI_QUERY = /(^|\s)(?:--?[a-z]|\||`|\$\(|\b(?:bash|zsh|sh|fish|git|npm|pnpm|yarn|bun|deno|node|python|pip|docker|kubectl|helm|aws|gcloud|az|terraform|ansible|curl|wget|ffmpeg|sed|awk|grep|rg|find|xargs|jq|tar|ssh|systemctl|journalctl|openssl|mysql|psql|redis-cli|mongo)\b)/i;

function numberFromEnv(name, fallback) {
  const value = Number(process.env[name]);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

export function normalizeQuery(query) {
  return String(query)
    .toLowerCase()
    .replace(PLACEHOLDERS, ' ')
    .replace(/[`"'“”‘’]/g, ' ')
    .replace(/[^a-z0-9%+._/-]+/g, ' ')
    .split(/\s+/)
    .filter(Boolean)
    .filter((token) => !STOPWORDS.has(token))
    .sort()
    .join(' ');
}

export function jaccard(left, right) {
  const a = new Set(String(left).split(/\s+/).filter(Boolean));
  const b = new Set(String(right).split(/\s+/).filter(Boolean));
  if (a.size === 0 || b.size === 0) return 0;
  let intersection = 0;
  for (const token of a) if (b.has(token)) intersection += 1;
  return intersection / (a.size + b.size - intersection);
}

function tokenOverlap(query, text) {
  const requested = new Set(normalizeQuery(query).split(' ').filter(Boolean));
  const available = new Set(normalizeQuery(text).split(' ').filter(Boolean));
  if (requested.size === 0 || available.size === 0) return 0;
  let hits = 0;
  for (const token of requested) if (available.has(token)) hits += 1;
  return hits / requested.size;
}

/**
 * Heuristic AEO score for one search result. It rewards the signals an
 * answer-engine-optimized page exposes before the model even fetches it:
 * official documentation, a documentation path, an answer-first snippet,
 * code or structured snippets, freshness, and query/title overlap.
 */
export function scoreAeo(result, query = '') {
  const signals = [];
  let score = 0;
  let url;
  try {
    url = new URL(result.url);
  } catch {
    return { score: 0, signals };
  }
  const host = url.hostname.toLowerCase();

  if (OFFICIAL_HOSTS.has(host) || host.startsWith('docs.') || host.startsWith('developer.')) {
    score += 25;
    signals.push('official');
  } else if (host === 'github.com' || host.endsWith('.github.com')) {
    score += 10;
    signals.push('github');
  }

  if (DOCS_PATH.test(url.pathname)) {
    score += 10;
    signals.push('docs-path');
  }

  const snippet = String(result.snippet || '');
  if (ANSWER_FIRST.test(snippet)) {
    score += 15;
    signals.push('answer-first');
  }
  if (/```|`[^`]+`/.test(snippet)) {
    score += 10;
    signals.push('code');
  }
  if (/(?:^|\n)\s*(?:\d+\.|[-*])\s+/m.test(snippet)) {
    score += 5;
    signals.push('structured');
  }

  if (result.age) {
    const age = Date.now() - Date.parse(result.age);
    if (Number.isFinite(age)) {
      if (age < 18 * 30 * 24 * 3600 * 1000) {
        score += 10;
        signals.push('fresh');
      } else if (age > 5 * 365 * 24 * 3600 * 1000) {
        score -= 10;
        signals.push('stale');
      }
    }
  }

  if (tokenOverlap(query, result.title) >= 0.5) {
    score += 10;
    signals.push('title-match');
  }

  if (FORUM_HOST.test(host)) {
    score -= 10;
    signals.push('forum');
  } else if (SECONDARY_HOST.test(host)) {
    score -= 5;
    signals.push('secondary');
  }

  return { score, signals };
}

export function rankByAeo(results) {
  return results
    .map((result, index) => ({ result, index }))
    .sort((a, b) => {
      const aAeo = Boolean(a.result.aeo);
      const bAeo = Boolean(b.result.aeo);
      if (aAeo !== bAeo) return aAeo ? -1 : 1;
      if (aAeo && bAeo) {
        return (
          Number(b.result.aeoScore || 0) - Number(a.result.aeoScore || 0) ||
          a.index - b.index
        );
      }
      return a.index - b.index;
    })
    .map(({ result }) => result);
}

function metaContent(html, name) {
  for (const match of html.matchAll(/<meta\b[^>]*>/gi)) {
    const tag = match[0];
    if (!new RegExp(`(?:name|property)=["']${name}["']`, 'i').test(tag)) continue;
    const content = tag.match(/content=["']([^"']*)["']/i);
    if (content) return cleanText(content[1]);
  }
  return '';
}

function collectJsonLdTypes(html) {
  const types = new Set();
  const visit = (value) => {
    if (!value || typeof value !== 'object') return;
    if (Array.isArray(value)) {
      for (const entry of value) visit(entry);
      return;
    }
    const type = value['@type'];
    if (typeof type === 'string') types.add(type);
    else if (Array.isArray(type)) {
      for (const entry of type) if (typeof entry === 'string') types.add(entry);
    }
    if (value['@graph']) visit(value['@graph']);
  };
  for (const match of html.matchAll(
    /<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi,
  )) {
    try {
      visit(JSON.parse(match[1]));
    } catch {
      // A malformed JSON-LD block is not an AEO signal.
    }
  }
  return types;
}

/**
 * Page-level AEO audit for one fetched URL, using the raw HTML before it is
 * stripped. Returns the score, the detected signals, and whether the page
 * clears the configured page threshold.
 */
export function auditAeo(html, url) {
  const raw = String(html);
  const signals = [];
  let score = 0;

  try {
    const host = new URL(url).hostname.toLowerCase();
    if (OFFICIAL_HOSTS.has(host) || host.startsWith('docs.') || host.startsWith('developer.')) {
      score += 10;
      signals.push('official');
    }
  } catch {
    // A malformed URL contributes no host signal.
  }

  const types = collectJsonLdTypes(raw);
  if (types.has('FAQPage')) {
    score += 20;
    signals.push('faq-schema');
  } else if (types.has('HowTo')) {
    score += 20;
    signals.push('howto-schema');
  } else if (types.has('TechArticle') || types.has('Article') || types.has('QAPage')) {
    score += 10;
    signals.push('article-schema');
  }

  const description = metaContent(raw, 'description') || metaContent(raw, 'og:description');
  if (description.length >= 50 && description.length <= 300) {
    score += 5;
    signals.push('meta-description');
  }

  const headings = [...raw.matchAll(/<h[23][^>]*>([\s\S]*?)<\/h[23]>/gi)]
    .map((match) => stripHtml(match[1]))
    .filter(Boolean);
  const questions = headings.filter(
    (heading) => /\?\s*$/.test(heading) || QUESTION.test(heading),
  ).length;
  if (questions > 0) {
    score += Math.min(15, questions * 5);
    signals.push('question-headings');
  }

  const firstParagraph = raw.match(/<p[^>]*>([\s\S]*?)<\/p>/i)?.[1] || '';
  const firstText = stripHtml(firstParagraph);
  if (firstText.length >= 40 && firstText.length <= 600 && ANSWER_FIRST.test(firstText)) {
    score += 10;
    signals.push('answer-first');
  }

  if (/<(?:pre|code)\b/i.test(raw)) {
    score += 5;
    signals.push('code');
  }
  if (/<(?:ul|ol)\b/i.test(raw)) {
    score += 5;
    signals.push('list');
  }

  const modified = raw.match(
    /(?:article:modified_time|dateModified|last-modified)["']?\s*[:=]\s*["']?([^"',<]+)/i,
  )?.[1] || '';
  const timestamp = Date.parse(modified);
  if (Number.isFinite(timestamp)) {
    const age = Date.now() - timestamp;
    if (age < 18 * 30 * 24 * 3600 * 1000) {
      score += 10;
      signals.push('fresh');
    } else if (age > 5 * 365 * 24 * 3600 * 1000) {
      score -= 5;
      signals.push('stale');
    }
  }

  return { score: Math.max(0, score), signals, optimized: score >= AEO_PAGE_MIN };
}

function stripFence(code) {
  return String(code)
    .replace(/^\s*```[a-zA-Z0-9+#.-]*\s*\n?/, '')
    .replace(/\n?```\s*$/, '')
    .trim();
}

function normalizeLanguage(value) {
  const language = String(value || 'bash').trim().toLowerCase();
  return /^[a-z0-9+#.-]{1,20}$/.test(language) ? language : 'bash';
}

function escapeLinkText(value) {
  return cleanText(value).replace(/([[\]])/g, '\\$1');
}

function escapeUrl(value) {
  return String(value).replace(/\)/g, '%29').replace(/\s/g, '%20');
}

/**
 * Canonical formatter for the quick agent's final answer. It is the only place
 * the output template is assembled, and it rejects source URLs that this turn
 * did not actually retrieve.
 */
export function formatAnswer(input, verifiedUrls = new Set()) {
  const issues = [];
  const allowed = verifiedUrls instanceof Set ? verifiedUrls : new Set(verifiedUrls);
  const solution = cleanText(input?.solution);
  if (!solution) issues.push('solution is required');

  const unverified = input?.unverified === true;
  const code = input?.code ? stripFence(input.code) : '';
  const language = normalizeLanguage(input?.language);
  const sources = [];
  for (const source of Array.isArray(input?.sources) ? input.sources : []) {
    const url = String(source?.url ?? '').trim();
    if (!/^https?:\/\//i.test(url)) {
      issues.push(`invalid source URL: ${url}`);
      continue;
    }
    if (!allowed.has(url)) {
      issues.push(`unverified source URL: ${url}`);
      continue;
    }
    sources.push({ title: cleanText(source?.title || url), url });
  }

  if (unverified && sources.length > 0) {
    issues.push('unverified:true conflicts with provided sources');
  }
  if (!unverified && sources.length === 0) {
    issues.push('at least one verified source is required (or set unverified:true)');
  }
  if (issues.length > 0) return { ok: false, issues, text: '' };

  const lines = [`**Solution:** ${solution}`];
  if (code) lines.push('', `\`\`\`${language}`, code, '```');
  lines.push('', '**Sources:**');
  if (unverified) {
    lines.push('- None — retrieval failed.');
    lines.push('', 'This is unverified — ask for deep research to verify it.');
  } else {
    for (const source of sources) {
      lines.push(`- [${escapeLinkText(source.title)}](${escapeUrl(source.url)})`);
    }
  }
  return { ok: true, issues: [], text: lines.join('\n') };
}

/**
 * Validates an already-written final message. Used by the idle audit when the
 * model bypasses the final_answer tool.
 */
export function validateAnswer(text, verifiedUrls = []) {
  const issues = [];
  const value = String(text || '').trim();
  if (!value) return { ok: false, issues: ['empty answer'] };

  const solutionIndex = value.indexOf('**Solution:**');
  const sourcesIndex = value.indexOf('**Sources:**');
  if (solutionIndex === -1) {
    issues.push('missing **Solution:** heading');
  } else {
    if (solutionIndex !== 0) issues.push('preamble before **Solution:**');
    const after = value.slice(solutionIndex + '**Solution:**'.length);
    const solutionLine = after
      .split('\n')
      .map((line) => line.trim())
      .find(Boolean);
    if (!solutionLine || solutionLine === '**Sources:**') issues.push('empty solution');
  }
  if (sourcesIndex === -1) issues.push('missing **Sources:** heading');
  if (solutionIndex > -1 && sourcesIndex > -1 && sourcesIndex < solutionIndex) {
    issues.push('**Sources:** before **Solution:**');
  }

  const links = [...value.matchAll(/\]\((https?:\/\/[^)\s]+)\)/g)].map((match) => match[1]);
  const allowed = new Set(verifiedUrls);
  for (const url of links) {
    if (!allowed.has(url)) issues.push(`unverified source ${url}`);
  }
  if (allowed.size > 0 && links.length === 0) {
    issues.push('missing verified source link');
  }
  return { ok: issues.length === 0, issues };
}

function repairPrompt(issues, verifiedUrls) {
  const allowed = verifiedUrls.length
    ? verifiedUrls.map((url) => `- ${url}`).join('\n')
    : '- (none verified this turn)';
  return [
    'Your previous reply did not pass the output contract:',
    ...issues.map((issue) => `- ${issue}`),
    '',
    'Rewrite the answer now. Do not run more searches or fetches.',
    'Call the `final_answer` tool with:',
    '- `solution`: the direct answer in 1-2 sentences.',
    '- `code` and `language` when the answer is a command or snippet.',
    '- `sources`: only these verified URLs:',
    allowed,
    '- `unverified: true` only when no verified source supports the answer.',
    'Then reply with exactly the formatted content and nothing else.',
  ].join('\n');
}

export function stripHtml(html) {
  return decodeEntities(
    String(html)
      .replace(/<head\b[\s\S]*?<\/head>/gi, ' ')
      .replace(/<script\b[\s\S]*?<\/script>/gi, ' ')
      .replace(/<style\b[\s\S]*?<\/style>/gi, ' ')
      .replace(/<noscript\b[\s\S]*?<\/noscript>/gi, ' ')
      .replace(/<svg\b[\s\S]*?<\/svg>/gi, ' ')
      .replace(/<template\b[\s\S]*?<\/template>/gi, ' ')
      .replace(/<br\s*\/?>/gi, '\n')
      .replace(/<\/(?:p|div|section|article|li|h[1-6]|tr|pre|blockquote)>/gi, '\n\n')
      .replace(/<[^>]+>/g, ' '),
  )
    .replace(/[ \t\f\v]+/g, ' ')
    .replace(/\n[ \t]+/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

export function truncateText(text, limit) {
  const value = String(text);
  if (value.length <= limit) return value;
  const slice = value.slice(0, limit);
  const paragraph = slice.lastIndexOf('\n\n');
  if (paragraph > limit * 0.6) return `${slice.slice(0, paragraph).trimEnd()}\n`;
  const space = slice.lastIndexOf(' ');
  return `${slice.slice(0, space > 0 ? space : limit).trimEnd()}\n`;
}

export function isSafeUrl(value) {
  try {
    const url = new URL(String(value));
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return false;
    const host = url.hostname.toLowerCase();
    if (host === 'localhost' || host.endsWith('.localhost')) return false;
    if (host === '127.0.0.1' || host === '0.0.0.0' || host === '[::1]') return false;
    if (/^(?:10\.|127\.|169\.254\.|192\.168\.)/.test(host)) return false;
    const private172 = host.match(/^172\.(\d+)\./);
    if (private172 && Number(private172[1]) >= 16 && Number(private172[1]) <= 31) return false;
    if (host.startsWith('[') && /^(?:fc|fd|fe80)/i.test(host.slice(1))) return false;
    if (host.endsWith('.local') || host.endsWith('.internal') || host.endsWith('.home.arpa')) return false;
    if (!host.includes('.') && !host.startsWith('[')) return false;
    return true;
  } catch {
    return false;
  }
}

function decodeEntities(text) {
  const named = {
    amp: '&',
    lt: '<',
    gt: '>',
    quot: '"',
    apos: "'",
    nbsp: ' ',
  };
  return text.replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, (match, code) => {
    if (code[0] === '#') {
      const hex = code[1].toLowerCase() === 'x';
      const value = parseInt(code.slice(hex ? 2 : 1), hex ? 16 : 10);
      return Number.isFinite(value) && value > 0 && value <= 0x10ffff
        ? String.fromCodePoint(value)
        : match;
    }
    return named[code.toLowerCase()] ?? match;
  });
}

function cleanText(value) {
  return String(value ?? '').replace(/\s+/g, ' ').trim();
}

function describeError(error) {
  if (!error) return 'unknown error';
  return error.cause?.message || error.message || error._tag || String(error);
}

export function websearchPayload(response) {
  return response?.data ?? response;
}

function hashKey(value) {
  return createHash('sha256').update(value).digest('hex');
}

function ttlFor(query) {
  return CLI_QUERY.test(String(query)) ? CLI_TTL_MS : SEARCH_TTL_MS;
}

function hostname(value) {
  try {
    return new URL(String(value)).hostname.toLowerCase();
  } catch {
    return '';
  }
}

function extractTitle(html) {
  const match = String(html).match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  return match ? stripHtml(match[1]) : '';
}

function prettyJson(raw) {
  try {
    return JSON.stringify(JSON.parse(raw), null, 2);
  } catch {
    return raw;
  }
}

function timeoutSignal(ms, parent) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error(`timed out after ${ms}ms`)), ms);
  const onAbort = () => controller.abort(parent?.reason);
  if (parent) {
    if (parent.aborted) controller.abort(parent.reason);
    else parent.addEventListener('abort', onAbort, { once: true });
  }
  return {
    signal: controller.signal,
    clear() {
      clearTimeout(timer);
      if (parent) parent.removeEventListener('abort', onAbort);
    },
  };
}

function withTimeout(promise, ms, label) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

async function fetchJson(url, init, signal) {
  const { signal: timeout, clear } = timeoutSignal(TOOL_TIMEOUT_MS, signal);
  try {
    const response = await fetch(url, { ...init, signal: timeout });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return await response.json();
  } finally {
    clear();
  }
}

async function cacheGet(storage, key) {
  try {
    const entry = await storage.get(key);
    if (!entry || typeof entry !== 'object') return null;
    if (typeof entry.expires === 'number' && entry.expires <= Date.now()) return null;
    return entry;
  } catch {
    return null;
  }
}

async function cacheSet(storage, key, value) {
  try {
    await storage.set(key, value);
  } catch {
    // The cache is an optimization; a storage failure must not fail the tool.
  }
}

function normalizeResults(rows, limit, query = '') {
  const seen = new Set();
  const results = [];
  for (const row of Array.isArray(rows) ? rows : []) {
    const url = typeof row?.url === 'string' ? row.url : '';
    if (!/^https?:\/\//i.test(url) || seen.has(url)) continue;
    seen.add(url);
    const published = row?.time?.published;
    const result = {
      title: cleanText(row?.title || url),
      url,
      snippet: truncateText(cleanText(row?.content || row?.snippet || ''), 400).trim(),
      age: typeof row?.age === 'string'
        ? row.age
        : typeof published === 'number' && Number.isFinite(published)
          ? new Date(published).toISOString().slice(0, 10)
          : null,
    };
    const aeo = scoreAeo(result, query);
    result.aeo = aeo.score >= AEO_SEARCH_MIN;
    result.aeoScore = aeo.score;
    results.push(result);
    if (results.length >= limit) break;
  }
  return results;
}

async function tavilySearch({ query, limit, signal }) {
  const body = {
    api_key: process.env.TAVILY_API_KEY,
    query,
    max_results: limit,
    search_depth: 'basic',
    include_answer: false,
  };
  const data = await fetchJson('https://api.tavily.com/search', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  }, signal);
  return { provider: 'tavily', results: normalizeResults(data?.results, limit, query) };
}

async function braveSearch({ query, limit, signal }) {
  const url = `https://api.search.brave.com/res/v1/web/search?q=${encodeURIComponent(query)}&count=${limit}`;
  const data = await fetchJson(url, {
    headers: {
      accept: 'application/json',
      'x-subscription-token': process.env.BRAVE_API_KEY,
    },
  }, signal);
  return { provider: 'brave', results: normalizeResults(data?.web?.results, limit, query) };
}

async function exaSearch({ query, limit, signal }) {
  const data = await fetchJson('https://api.exa.ai/search', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': process.env.EXA_API_KEY,
    },
    body: JSON.stringify({
      query,
      numResults: limit,
      contents: { text: { maxCharacters: 600 } },
    }),
  }, signal);
  return { provider: 'exa', results: normalizeResults(data?.results, limit, query) };
}

async function opencodeSearch({ ctx, query, limit }) {
  const errors = [];
  const attempts = [
    {},
    { providerID: process.env.QUICK_AGENT_SEARCH_PROVIDER || 'parallel' },
  ];
  for (const extra of attempts) {
    try {
      const response = await withTimeout(
        ctx.websearch.query({ query, ...extra }),
        TOOL_TIMEOUT_MS,
        'opencode websearch',
      );
      const payload = websearchPayload(response);
      const rows = Array.isArray(payload) ? payload : payload?.results ?? [];
      const provider = typeof payload?.providerID === 'string'
        ? `opencode:${payload.providerID}`
        : 'opencode';
      const results = normalizeResults(rows, limit, query);
      if (results.length > 0) return { provider, results };
      errors.push('no results');
    } catch (error) {
      errors.push(describeError(error));
    }
  }
  throw new Error(`opencode websearch failed: ${errors.join('; ')}`);
}

async function searxngSearch({ query, limit, signal }) {
  const base = String(process.env.SEARXNG_URL).replace(/\/+$/, '');
  const url = `${base}/search?q=${encodeURIComponent(query)}&format=json&count=${limit}`;
  const data = await fetchJson(url, {}, signal);
  return { provider: 'searxng', results: normalizeResults(data?.results, limit, query) };
}

async function searchWithProviders(ctx, query, limit, signal) {
  const providers = [];
  if (process.env.TAVILY_API_KEY) providers.push({ name: 'tavily', run: tavilySearch });
  if (process.env.BRAVE_API_KEY) providers.push({ name: 'brave', run: braveSearch });
  if (process.env.EXA_API_KEY) providers.push({ name: 'exa', run: exaSearch });
  providers.push({ name: 'opencode', run: opencodeSearch });
  if (process.env.SEARXNG_URL) providers.push({ name: 'searxng', run: searxngSearch });

  const failures = [];
  for (const provider of providers) {
    try {
      const result = await provider.run({ ctx, query, limit, signal });
      if (result.results.length > 0) return result;
      failures.push(`${provider.name}: no results`);
    } catch (error) {
      failures.push(`${provider.name}: ${describeError(error)}`);
    }
  }
  throw new Error(`SEARCH_FAILED: ${failures.join('; ') || 'no search provider configured'}`);
}

async function fetchPage(url, signal) {
  const { signal: timeout, clear } = timeoutSignal(TOOL_TIMEOUT_MS, signal);
  try {
    const response = await fetch(url, {
      signal: timeout,
      redirect: 'follow',
      headers: {
        'user-agent': 'opencode-quick-agent/1.0',
        accept: 'text/html,application/xhtml+xml,text/plain,application/json;q=0.9,*/*;q=0.1',
      },
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    if (!isSafeUrl(response.url)) throw new Error('redirected to a non-public URL');

    const declared = Number(response.headers.get('content-length') || 0);
    if (declared > MAX_PAGE_BYTES) throw new Error(`response too large (${declared} bytes)`);

    const type = (response.headers.get('content-type') || '').toLowerCase();
    const raw = await response.text();
    if (raw.length > MAX_PAGE_BYTES) throw new Error('response too large');

    const title = cleanText(extractTitle(raw)) || response.url;
    const text = type.includes('json')
      ? prettyJson(raw)
      : type.includes('html') || type.includes('xml') || /<html[\s>]/i.test(raw)
        ? stripHtml(raw)
        : raw;
    const truncated = text.length > FETCH_MAX_CHARS;
    return {
      url: response.url,
      title,
      text: truncateText(text, FETCH_MAX_CHARS).trim(),
      truncated,
      aeo: auditAeo(raw, response.url),
    };
  } finally {
    clear();
  }
}

function createState() {
  return {
    turnStart: new Map(),
    calls: new Map(),
    queries: new Map(),
    urls: new Map(),
    failures: new Map(),
    blocked: new Map(),
  };
}

function resetTurn(state, sessionID) {
  state.turnStart.set(sessionID, Date.now());
  state.calls.set(sessionID, 0);
  state.queries.set(sessionID, []);
  state.urls.set(sessionID, []);
  state.failures.set(sessionID, 0);
  state.blocked.delete(sessionID);
}

async function clearTurnStorage(storage, sessionID) {
  try {
    await Promise.all([
      storage.remove(`verified/${sessionID}`),
      storage.remove(`finalAnswer/${sessionID}`),
      storage.remove(`repairAttempts/${sessionID}`),
    ]);
  } catch {
    // Turn cleanup is best effort.
  }
}

async function rememberUrls(storage, sessionID, urls) {
  if (!sessionID) return;
  try {
    const key = `verified/${sessionID}`;
    const current = await storage.get(key);
    const set = new Set(Array.isArray(current) ? current : []);
    for (const url of urls) {
      if (typeof url === 'string' && /^https?:\/\//i.test(url)) set.add(url);
    }
    await storage.set(key, [...set]);
  } catch {
    // Verification memory is best effort.
  }
}

function messageText(message) {
  if (!message) return '';
  if (typeof message.text === 'string') return message.text.trim();
  const parts = Array.isArray(message.content)
    ? message.content
    : Array.isArray(message.parts)
      ? message.parts
      : [];
  return parts
    .filter((part) => part?.type === 'text' && typeof part.text === 'string')
    .map((part) => part.text)
    .join('\n')
    .trim();
}

function lastAssistantText(messages) {
  const list = Array.isArray(messages) ? messages : messages?.data || [];
  for (let index = list.length - 1; index >= 0; index -= 1) {
    const message = list[index];
    if (message?.type !== 'assistant') continue;
    const text = messageText(message);
    if (text) return text;
  }
  return '';
}

function isEscalationStatus(text) {
  return (
    !text.includes('**Solution:**') &&
    /research is running|started .*deep-research|delegated to .*deep-research/i.test(text)
  );
}

const IN_FLIGHT_REPAIRS = new Set();

async function requestRepair(ctx, sessionID, text) {
  if (IN_FLIGHT_REPAIRS.has(sessionID)) return;
  IN_FLIGHT_REPAIRS.add(sessionID);
  try {
    await ctx.storage.set(`repairAttempts/${sessionID}`, 1);
    await ctx.session.prompt({
      sessionID,
      delivery: 'queue',
      metadata: { quickRepair: true },
      text,
    });
  } catch (error) {
    try {
      await ctx.storage.remove(`repairAttempts/${sessionID}`);
    } catch {
      // Leave the attempt marker for the next user prompt to clear.
    }
    throw error;
  } finally {
    IN_FLIGHT_REPAIRS.delete(sessionID);
  }
}

/**
 * One-shot post-processing audit. It only acts when the final message bypassed
 * the final_answer tool or does not match the contract. A second repair is
 * never attempted, so a non-compliant model cannot create a loop. Verified
 * URLs, final answers, and repair attempts live in plugin storage so every
 * plugin instance sees the same turn state.
 */
async function auditIdle(ctx, sessionID) {
  if (!sessionID) return;

  let session;
  try {
    session = await ctx.session.get({ sessionID });
  } catch {
    return;
  }
  if (!session || session.agent !== 'quick' || session.parentID) return;
  const sessionDirectory = String(session.location?.directory || '').replace(/\/+$/, '');
  const pluginDirectory = String(ctx.location?.directory || '').replace(/\/+$/, '');
  if (sessionDirectory && pluginDirectory && sessionDirectory !== pluginDirectory) return;

  let messages;
  try {
    messages = await ctx.session.context({ sessionID });
  } catch {
    return;
  }

  const text = lastAssistantText(messages);
  const [verifiedRaw, finalAnswer, attemptsRaw] = await Promise.all([
    ctx.storage.get(`verified/${sessionID}`).catch(() => []),
    ctx.storage.get(`finalAnswer/${sessionID}`).catch(() => undefined),
    ctx.storage.get(`repairAttempts/${sessionID}`).catch(() => 0),
  ]);
  const verified = Array.isArray(verifiedRaw) ? verifiedRaw : [];
  const attempts = typeof attemptsRaw === 'number' ? attemptsRaw : 0;

  if (!text) {
    if (!finalAnswer || attempts > 0) return;
    await requestRepair(
      ctx,
      sessionID,
      'Your last turn ended after the `final_answer` tool call. Reply with exactly the content returned by that tool and nothing else.',
    );
    return;
  }

  if (isEscalationStatus(text)) return;
  if (!text.includes('**Solution:**') && /\?\s*$/.test(text)) return;

  const validation = validateAnswer(text, verified);
  if (validation.ok) {
    try {
      await ctx.storage.remove(`repairAttempts/${sessionID}`);
    } catch {
      // The next prompt clears it.
    }
    return;
  }
  if (attempts > 0) {
    try {
      await ctx.storage.remove(`repairAttempts/${sessionID}`);
    } catch {
      // The next prompt clears it.
    }
    return;
  }

  await requestRepair(ctx, sessionID, repairPrompt(validation.issues, verified));
}

function guardBefore(state, event) {
  if (event.agent !== 'quick' || !NETWORK_TOOLS.has(event.tool)) return;

  const sessionID = event.sessionID;
  const calls = state.calls.get(sessionID) ?? 0;
  const started = state.turnStart.get(sessionID) ?? Date.now();
  if (calls > 0 && Date.now() - started > BUDGET_MS) {
    const elapsed = Math.round((Date.now() - started) / 1000);
    throw new Error(
      `BUDGET_EXCEEDED: ${elapsed}s elapsed; synthesize now from collected results or delegate to deep-research.`,
    );
  }

  const blocked = state.blocked.get(sessionID);
  const host = event.tool === 'fast_fetch' ? hostname(event.input?.url) : '';
  if (blocked?.has(event.tool) || (host && blocked?.has(host))) {
    throw new Error(
      `SOURCE_BLOCKED: ${host || event.tool} failed twice this turn; pivot to another source or delegate to deep-research.`,
    );
  }

  if (event.tool === 'fast_search' && typeof event.input?.query === 'string') {
    const normalized = normalizeQuery(event.input.query);
    const prior = state.queries.get(sessionID) ?? [];
    if (prior.some((entry) => jaccard(entry, normalized) > 0.75)) {
      throw new Error(
        'DUPLICATE_QUERY: this query is too similar to one already tried this turn; synthesize from collected results or delegate to deep-research.',
      );
    }
    prior.push(normalized);
    state.queries.set(sessionID, prior.slice(-12));
  }

  if (event.tool === 'fast_fetch' && typeof event.input?.url === 'string') {
    const seen = state.urls.get(sessionID) ?? [];
    if (seen.includes(event.input.url)) {
      throw new Error(
        'DUPLICATE_URL: this URL was already fetched this turn; use the page content you already have.',
      );
    }
    seen.push(event.input.url);
    state.urls.set(sessionID, seen.slice(-12));
  }

  state.calls.set(sessionID, calls + 1);
}

function recordAfter(state, event) {
  if (event.agent !== 'quick' || !NETWORK_TOOLS.has(event.tool)) return;

  const sessionID = event.sessionID;
  const failed = event.status === 'error' || event.result?.metadata?.ok === false;
  if (!failed) {
    state.failures.set(sessionID, 0);
    return;
  }

  const count = (state.failures.get(sessionID) ?? 0) + 1;
  state.failures.set(sessionID, count);
  if (count < 2) return;

  const blocked = state.blocked.get(sessionID) ?? new Set();
  blocked.add(event.tool);
  if (event.tool === 'fast_fetch') {
    const host = hostname(event.input?.url);
    if (host) blocked.add(host);
  }
  state.blocked.set(sessionID, blocked);
}

export default {
  id: PLUGIN_ID,
  async setup(ctx) {
    const state = createState();

    await ctx.session.hook('prompt', async (event) => {
      const sessionID = event.sessionID || 'default';
      if (event.metadata?.quickRepair === true) return;
      resetTurn(state, sessionID);
      await clearTurnStorage(ctx.storage, sessionID);
    });

    await ctx.tool.hook('execute.before', (event) => {
      guardBefore(state, event);
    });

    await ctx.tool.hook('execute.after', (event) => {
      recordAfter(state, event);
    });

    await ctx.tool.transform((editor) => {
      editor.add({
        name: 'fast_search',
        description:
          'Search official docs, GitHub issues/releases, and the web, then rank results for answer-engine optimization (AEO). Returns title, URL, snippet, age, aeo, and aeoScore. Cached.',
        input: {
          type: 'object',
          properties: {
            query: {
              type: 'string',
              description: 'Precise query; include the tool, language, and version when known.',
            },
            limit: {
              type: 'integer',
              minimum: 1,
              maximum: MAX_RESULTS,
              description: 'Maximum results to return (default 5).',
            },
          },
          required: ['query'],
          additionalProperties: false,
        },
        options: { codemode: false, permission: 'fast_search' },
        execute: async (input, context) => {
          const query = String(input?.query ?? '').trim();
          if (!query) throw new Error('fast_search: query is required');
          const limit = Math.min(Math.max(Number(input?.limit) || 5, 1), MAX_RESULTS);
          const normalized = normalizeQuery(query);
          const key = `${CACHE_PREFIX}search/${hashKey(normalized)}`;

          const cached = await cacheGet(ctx.storage, key);
          if (cached?.results && cached.results.every((result) => typeof result.aeo === 'boolean')) {
            await rememberUrls(ctx.storage, context.sessionID, cached.results.map((result) => result.url));
            return {
              content: JSON.stringify({
                query,
                provider: cached.provider,
                cached: true,
                ageSeconds: Math.round((Date.now() - cached.createdAt) / 1000),
                results: rankByAeo(cached.results).slice(0, limit),
              }),
              metadata: { ok: true },
            };
          }

          const result = await searchWithProviders(ctx, query, MAX_RESULTS, context.signal);
          const ranked = rankByAeo(result.results);
          await rememberUrls(ctx.storage, context.sessionID, ranked.map((entry) => entry.url));
          await cacheSet(ctx.storage, key, {
            provider: result.provider,
            results: ranked,
            createdAt: Date.now(),
            expires: Date.now() + ttlFor(query),
          });
          return {
            content: JSON.stringify({
              query,
              provider: result.provider,
              cached: false,
              results: ranked.slice(0, limit),
            }),
            metadata: { ok: true },
          };
        },
      });

      editor.add({
        name: 'fast_fetch',
        description:
          'Fetch one public documentation URL and return stripped text capped at 4000 characters plus an AEO audit (score, signals, optimized). Cached.',
        input: {
          type: 'object',
          properties: {
            url: {
              type: 'string',
              description: 'Absolute http(s) URL to fetch.',
            },
          },
          required: ['url'],
          additionalProperties: false,
        },
        options: { codemode: false, permission: 'fast_fetch' },
        execute: async (input, context) => {
          const url = String(input?.url ?? '').trim();
          if (!isSafeUrl(url)) {
            throw new Error('fast_fetch: only public http(s) URLs are allowed');
          }
          const key = `${CACHE_PREFIX}fetch/${hashKey(url)}`;

          const cached = await cacheGet(ctx.storage, key);
          if (
            typeof cached?.text === 'string' &&
            cached.aeo &&
            typeof cached.aeo.score === 'number'
          ) {
            await rememberUrls(ctx.storage, context.sessionID, [cached.url]);
            return {
              content: JSON.stringify({
                url: cached.url,
                title: cached.title,
                truncated: cached.truncated,
                cached: true,
                ageSeconds: Math.round((Date.now() - cached.createdAt) / 1000),
                aeo: cached.aeo,
                text: cached.text,
              }),
              metadata: { ok: cached.text.length > 0, aeoScore: cached.aeo.score },
            };
          }

          const page = await fetchPage(url, context.signal);
          await rememberUrls(ctx.storage, context.sessionID, [page.url]);
          await cacheSet(ctx.storage, key, {
            ...page,
            createdAt: Date.now(),
            expires: Date.now() + SEARCH_TTL_MS,
          });
          return {
            content: JSON.stringify({
              url: page.url,
              title: page.title,
              truncated: page.truncated,
              cached: false,
              aeo: page.aeo,
              text: page.text,
            }),
            metadata: { ok: page.text.length > 0, aeoScore: page.aeo.score },
          };
        },
      });

      editor.add({
        name: 'final_answer',
        description:
          'Format and validate the final answer. Rejects source URLs that this turn did not retrieve and always emits the canonical template.',
        input: {
          type: 'object',
          properties: {
            solution: {
              type: 'string',
              description: 'Direct answer in 1-2 sentences.',
            },
            code: {
              type: 'string',
              description: 'Optional copy-pasteable command or minimal snippet.',
            },
            language: {
              type: 'string',
              description: 'Fence language for the code block (default bash).',
            },
            sources: {
              type: 'array',
              description: 'Only URLs returned by fast_search or fast_fetch this turn.',
              items: {
                type: 'object',
                properties: {
                  title: { type: 'string' },
                  url: { type: 'string' },
                },
                required: ['url'],
                additionalProperties: false,
              },
            },
            unverified: {
              type: 'boolean',
              description: 'True only when no verified source supports the answer.',
            },
          },
          required: ['solution'],
          additionalProperties: false,
        },
        options: { codemode: false, permission: 'final_answer' },
        execute: async (input, context) => {
          const verifiedRaw = await ctx.storage.get(`verified/${context.sessionID}`).catch(() => []);
          const verified = new Set(Array.isArray(verifiedRaw) ? verifiedRaw : []);
          const formatted = formatAnswer(input, verified);
          if (!formatted.ok) {
            throw new Error(`final_answer: ${formatted.issues.join('; ')}`);
          }
          try {
            await ctx.storage.set(`finalAnswer/${context.sessionID}`, formatted.text);
          } catch {
            // The formatted answer is still returned; the idle audit may repair.
          }
          return {
            content: formatted.text,
            metadata: {
              ok: true,
              sources: Array.isArray(input?.sources) ? input.sources.length : 0,
            },
          };
        },
      });
    });

    const controller = new AbortController();
    if (typeof ctx.event?.subscribe === 'function') {
      void (async () => {
        try {
          for await (const event of ctx.event.subscribe({
            types: ['session.execution.succeeded'],
            signal: controller.signal,
          })) {
            if (event?.type !== 'session.execution.succeeded') continue;
            const sessionID = event?.data?.sessionID || event?.sessionID;
            if (!sessionID) continue;
            try {
              await auditIdle(ctx, sessionID);
            } catch {
              // A repair failure must not stop future idles.
            }
          }
        } catch {
          // The plugin unloaded and aborted the event stream.
        }
      })();
      return () => controller.abort();
    }
  },
};

export const __test = {
  hashKey,
  ttlFor,
  timeoutSignal,
  withTimeout,
};
