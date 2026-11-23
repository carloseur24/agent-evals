import assert from 'node:assert/strict';
import test from 'node:test';

import plugin, {
  __test,
  auditAeo,
  formatAnswer,
  isExplanationPrompt,
  isSafeUrl,
  jaccard,
  normalizeQuery,
  rankByAeo,
  scoreAeo,
  stripHtml,
  truncateText,
  isRuntimeSummary,
  validateAnswer,
  validateExplanation,
  websearchPayload,
} from './index.js';

test('normalizeQuery sorts tokens, drops stopwords, and ignores date placeholders', () => {
  assert.equal(
    normalizeQuery('How do I format a date in bash?'),
    'bash date format',
  );
  assert.equal(
    normalizeQuery('bash format date yyyy-mm-dd'),
    'bash date format',
  );
});

test('jaccard scores paraphrases and unrelated queries', () => {
  assert.equal(
    jaccard(normalizeQuery('format date in bash'), normalizeQuery('bash format date yyyy-mm-dd')),
    1,
  );
  assert.equal(jaccard('bash date format', 'python parse json'), 0);
});

test('stripHtml removes scripts, styles, and tags while decoding entities', () => {
  const html = [
    '<html><head><title>Ignored</title><style>.x { color: red }</style></head>',
    '<body><h1>Hello</h1><script>steal()</script><p>World &amp; more</p></body></html>',
  ].join('');
  const text = stripHtml(html);
  assert.match(text, /Hello/);
  assert.match(text, /World & more/);
  assert.doesNotMatch(text, /steal|color: red|<h1>/);
});

test('truncateText stops at a word or paragraph boundary', () => {
  const words = truncateText('word '.repeat(2_000).trim(), 4_000);
  assert.ok(words.length <= 4_001);
  assert.ok(words.trimEnd().split(/\s+/).every((word) => word === 'word'));

  const paragraphs = truncateText(`${'A'.repeat(3_000)}\n\n${'B'.repeat(2_000)}`, 4_000);
  assert.equal(paragraphs.trimEnd(), 'A'.repeat(3_000));
});

test('isSafeUrl accepts public URLs and rejects local or private targets', () => {
  assert.equal(isSafeUrl('https://example.com/docs'), true);
  assert.equal(isSafeUrl('http://127.0.0.1:3000'), false);
  assert.equal(isSafeUrl('http://localhost:3000'), false);
  assert.equal(isSafeUrl('http://192.168.1.1'), false);
  assert.equal(isSafeUrl('http://[::1]/'), false);
  assert.equal(isSafeUrl('file:///etc/passwd'), false);
});

test('websearchPayload unwraps the plugin envelope and keeps a bare response', () => {
  const payload = {
    providerID: 'parallel',
    results: [{ url: 'https://example.com', title: 'Example' }],
  };
  assert.deepEqual(websearchPayload({ location: {}, data: payload }), payload);
  assert.deepEqual(websearchPayload(payload), payload);
});

test('scoreAeo prefers official answer-first results and marks forums lower', () => {
  const official = scoreAeo(
    {
      title: 'Date.now() - JavaScript | MDN',
      url: 'https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/Date/now',
      snippet: 'Use Date.now() to get milliseconds since the epoch. `Date.now()` returns a number.',
      age: new Date().toISOString().slice(0, 10),
    },
    'JavaScript current Unix timestamp',
  );
  assert.ok(official.score >= 40);
  assert.ok(official.signals.includes('official'));
  assert.ok(official.signals.includes('docs-path'));
  assert.ok(official.signals.includes('answer-first'));

  const forum = scoreAeo(
    {
      title: 'bash format date yyyy-mm-dd',
      url: 'https://stackoverflow.com/questions/1401482/yyyy-mm-dd-format-date-in-shell-script',
      snippet: 'Use date +%Y-%m-%d. `date +%F` also works.',
      age: null,
    },
    'bash format date',
  );
  assert.ok(forum.score < 40);
  assert.ok(forum.signals.includes('forum'));
});

test('rankByAeo puts optimized results first and keeps provider order for ties', () => {
  const ranked = rankByAeo([
    { title: 'plain', aeo: false, aeoScore: 20 },
    { title: 'best', aeo: true, aeoScore: 60 },
    { title: 'second', aeo: true, aeoScore: 45 },
    { title: 'plain-2', aeo: false, aeoScore: 30 },
  ]);
  assert.deepEqual(ranked.map((result) => result.title), ['best', 'second', 'plain', 'plain-2']);
});

test('auditAeo detects FAQ schema, question headings, and answer-first pages', () => {
  const html = [
    '<html><head><title>How do I format a date in bash?</title>',
    '<meta name="description" content="Use date +%Y-%m-%d to format a date in bash. This page explains the format and examples.">',
    '<script type="application/ld+json">',
    '{"@context":"https://schema.org","@type":"FAQPage","mainEntity":[{"@type":"Question","name":"How do I format a date?","acceptedAnswer":{"@type":"Answer","text":"Use date +%Y-%m-%d."}}]}',
    '</script></head><body>',
    '<h2>How do I format a date as YYYY-MM-DD?</h2>',
    '<p>Use the date command with the plus sign and format specifiers.</p>',
    '<pre><code>date +%Y-%m-%d</code></pre>',
    '<ul><li>GNU date</li><li>BSD date</li></ul>',
    '</body></html>',
  ].join('');
  const aeo = auditAeo(html, 'https://example.com/docs/bash-date');
  assert.ok(aeo.score >= 25);
  assert.equal(aeo.optimized, true);
  assert.ok(aeo.signals.includes('faq-schema'));
  assert.ok(aeo.signals.includes('question-headings'));
  assert.ok(aeo.signals.includes('answer-first'));
});

test('auditAeo leaves a plain page unoptimized', () => {
  const aeo = auditAeo(
    '<html><head><title>Example</title></head><body><p>Hello world.</p></body></html>',
    'https://example.com',
  );
  assert.equal(aeo.optimized, false);
  assert.equal(aeo.score, 0);
});

test('formatAnswer builds the canonical template and rejects unverified sources', () => {
  const url =
    'https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/Date/now';
  const verified = new Set([url]);

  const formatted = formatAnswer(
    {
      solution: 'Use Date.now() and divide by 1000.',
      code: 'Math.floor(Date.now() / 1000)',
      language: 'js',
      sources: [{ title: 'Date.now() - MDN', url }],
    },
    verified,
  );
  assert.equal(formatted.ok, true);
  assert.match(formatted.text, /^\*\*Solution:\*\* Use Date\.now/);
  assert.match(formatted.text, /```js\nMath\.floor/);
  assert.match(formatted.text, /\[Date\.now\(\) - MDN\]\(https:\/\/developer/);

  const unverified = formatAnswer({ solution: 'Unknown.', unverified: true }, verified);
  assert.equal(unverified.ok, true);
  assert.match(unverified.text, /None — retrieval failed/);
  assert.match(unverified.text, /This is unverified/);

  const invented = formatAnswer(
    { solution: 'Invented.', sources: [{ title: 'Fake', url: 'https://invented.example' }] },
    verified,
  );
  assert.equal(invented.ok, false);
  assert.match(invented.issues.join(' '), /unverified source URL/);

  const long = formatAnswer({ solution: 'x'.repeat(401), unverified: true }, verified);
  assert.equal(long.ok, false);
  assert.match(long.issues.join(' '), /too long/);

  const withExplanation = formatAnswer(
    {
      solution: 'Squash rewrites commit identity.',
      explanation:
        '**Why**\n\nA stack depends on commit identity.\n\n**Bad**\n- Squash.\n\n**Good**\n- Merge commit.',
      unverified: true,
    },
    verified,
  );
  assert.equal(withExplanation.ok, true);
  assert.match(withExplanation.text, /\*\*Why\*\*/);
  assert.match(withExplanation.text, /\*\*Bad\*\*/);
});

test('isExplanationPrompt detects explanation requests without catching lookups', () => {
  assert.equal(isExplanationPrompt('explain to me why squash is wrong'), true);
  assert.equal(isExplanationPrompt('walk me through the merge flow'), true);
  assert.equal(isExplanationPrompt('how does a stack merge work?'), true);
  assert.equal(isExplanationPrompt('how do I format a date in bash?'), false);
});

test('isRuntimeSummary detects the forced max-steps message', () => {
  assert.equal(
    isRuntimeSummary(
      'Maximum steps for this agent have been reached, so tools are now disabled. Here is a summary of the turn.',
    ),
    true,
  );
  assert.equal(isRuntimeSummary('**Solution:** Use `composer install --no-dev`.'), false);
});

test('validateExplanation accepts a structured explanation and rejects a dense wall', () => {
  const readable = [
    '**The mechanism**',
    '',
    'A stack is a chain of branches. Each branch sits on the previous one.',
    '',
    '**Good approach**',
    '- Merge with a merge commit.',
    '',
    '**Bad approach**',
    '- Squash rewrites the base.',
  ].join('\n');
  assert.equal(validateExplanation(readable).ok, true);

  const dense = `${'This is one long paragraph. '.repeat(40)}Good and bad.`;
  const validation = validateExplanation(dense);
  assert.equal(validation.ok, false);
  assert.match(validation.issues.join(' '), /paragraph too long|headings or bullet lists/);
});

test('validateAnswer catches missing headings, preamble, and unverified links', () => {
  const url =
    'https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/Date/now';
  const valid = `**Solution:** Use Date.now().\n\n**Sources:**\n- [MDN](${url})`;
  assert.equal(validateAnswer(valid, [url]).ok, true);
  assert.match(validateAnswer(`Preamble\n\n${valid}`, [url]).issues.join(' '), /preamble/);
  assert.match(
    validateAnswer('**Solution:** Use it.', [url]).issues.join(' '),
    /missing \*\*Sources/,
  );
  assert.match(
    validateAnswer(
      '**Solution:** Use it.\n\n**Sources:**\n- [Fake](https://invented.example)',
      [url],
    ).issues.join(' '),
    /unverified source/,
  );
  const unverified =
    '**Solution:** Unknown.\n\n**Sources:**\n- None — retrieval failed.\n\nThis is unverified — ask for deep research to verify it.';
  assert.equal(validateAnswer(unverified, []).ok, true);
});

test('fast_search registers, ranks AEO first, and caches the ranked list', async () => {
  const tools = new Map();
  const storage = new Map();
  let calls = 0;
  const rows = [
    {
      url: 'https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/Date/now',
      title: 'Date.now() - JavaScript | MDN',
      content: 'Use Date.now() to get milliseconds. `Date.now()` returns a number.',
      time: { published: Date.now() - 86_400_000 },
    },
    {
      url: 'https://stackoverflow.com/questions/1401482/yyyy-mm-dd-format-date-in-shell-script',
      title: 'bash format date yyyy-mm-dd',
      content: 'Use date +%Y-%m-%d. `date +%F` also works.',
      time: { published: Date.now() - 86_400_000 },
    },
    {
      url: 'https://example.com/blog/date',
      title: 'A blog about dates',
      content: 'Some text.',
      time: {},
    },
  ];
  const ctx = {
    session: {
      hook: async () => {},
      get: async () => ({ agent: 'quick' }),
      context: async () => [],
      prompt: async () => {},
    },
    event: { subscribe: async function* () {} },
    tool: {
      hook: async () => {},
      transform: async (callback) => {
        callback({ add: (tool) => tools.set(tool.name, tool) });
      },
    },
    storage: {
      get: async (key) => storage.get(key),
      set: async (key, value) => storage.set(key, value),
      remove: async (key) => storage.delete(key),
    },
    websearch: {
      query: async () => {
        calls += 1;
        return { data: { providerID: 'mock', results: rows } };
      },
    },
  };

  await plugin.setup(ctx);
  const fastSearch = tools.get('fast_search');
  assert.ok(fastSearch);

  const input = { query: 'JavaScript current Unix timestamp', limit: 3 };
  const context = { signal: new AbortController().signal, sessionID: 's1' };
  const first = JSON.parse((await fastSearch.execute(input, context)).content);
  assert.equal(first.provider, 'opencode:mock');
  assert.equal(first.cached, false);
  assert.deepEqual(
    first.results.map((result) => result.aeo),
    [true, false, false],
  );
  assert.ok(first.results[0].aeoScore >= 40);

  const second = JSON.parse((await fastSearch.execute(input, context)).content);
  assert.equal(second.cached, true);
  assert.deepEqual(
    second.results.map((result) => result.url),
    first.results.map((result) => result.url),
  );
  assert.equal(calls, 1);

  const finalAnswer = tools.get('final_answer');
  assert.ok(finalAnswer);
  const formatted = await finalAnswer.execute(
    {
      solution: 'Use Date.now() and divide by 1000.',
      code: 'Math.floor(Date.now() / 1000)',
      language: 'js',
      sources: [{ title: 'Date.now() - MDN', url: first.results[0].url }],
    },
    { sessionID: 's1' },
  );
  assert.match(formatted.content, /^\*\*Solution:\*\*/);
  assert.match(formatted.content, /```js/);
  assert.match(formatted.content, /Date\.now\(\) - MDN/);

  await assert.rejects(
    () =>
      finalAnswer.execute(
        { solution: 'Fake.', sources: [{ url: 'https://invented.example' }] },
        { sessionID: 's1' },
      ),
    /unverified source URL/,
  );
});

test('ttlFor keeps CLI syntax longer than docs', () => {
  assert.equal(__test.ttlFor('bash date format'), 7 * 24 * 60 * 60 * 1000);
  assert.equal(__test.ttlFor('react useEffect cleanup'), 24 * 60 * 60 * 1000);
});
