# Quick agent

A sub-30-second, source-cited answer agent for OpenCode V2 and
DeepSeek-V4.1-Flash-1017. It borrows the single-answer contract from
`gleitz/howdoi` but replaces scraping and prompt-only discipline with bounded
tools and deterministic circuit breakers.

## Files

```text
agents/quick.md                  primary, steps: 3, model variant #low
agents/deep-research.md          subagent, steps: 14, model variant #high
plugins/quick-agent/index.js     fast_search, fast_fetch, circuit breakers
plugins/quick-agent/quick-agent.test.mjs
scripts/install.sh               publishes agents/ and plugins/ into the config
scripts/doctor.mjs               verifies registration, links, and self-test
```

## Contract

`quick` answers directly when the question is single-hop: CLI flags, shell
one-liners, regexes, SQL syntax, library signatures, and single-doc error
lookups. It delegates to `deep-research` when the answer needs three or more
sources, conflicts between official docs and recent issues, a version
migration, or local code inspection.

Every answer uses one template: a one-or-two-sentence solution, the exact
command or snippet, and at least one verified URL. URLs and versions are never
invented. Retrieval is AEO-first: the agent tries the best answer-engine
optimized result first and falls back to the normal provider order when no AEO
page answers.

## V2 mapping

The source specification uses V1 names. The implementation uses the V2 API:

| Specification | Implemented |
|---|---|
| `task` tool | `subagent` tool, agent ID `deep-research` |
| `bash` permission | `shell` permission, denied with `*` |
| `.opencode/tools/*.ts` | `ctx.tool.transform` in a local plugin |
| `tool.execute.before` / `after` | `ctx.tool.hook("execute.before" / "execute.after")` |
| `opencode.json` `agent` block | Markdown frontmatter in `agents/` |
| `temperature` | Model variant `#low` / `#high` (`reasoningEffort`) |
| SQLite cache | `ctx.storage`, namespaced and durable |

No `opencode.json` edit is required. The agents are discovered from
`~/.config/opencode/agents/` and the plugin from `~/.config/opencode/plugins/`
after `bash scripts/install.sh`.

## Tools

`fast_search` normalizes the query (lowercase, stopwords removed, tokens
sorted, date placeholders ignored), checks the cache, then tries providers in
this order:

1. `TAVILY_API_KEY`
2. `BRAVE_API_KEY`
3. `EXA_API_KEY`
4. the OpenCode websearch integration (Exa, Parallel, Tavily, Firecrawl, or
   TinyFish, whichever is selected)
5. `SEARXNG_URL`

If the OpenCode integration throws, the tool retries once with
`QUICK_AGENT_SEARCH_PROVIDER` (default `parallel`), because a location can
carry a stale or unauthenticated default provider. Every HTTP call is aborted
after 4 seconds. Results are `{title, url, snippet, age, aeo, aeoScore}`. Docs
are cached for 24 hours and CLI syntax for 7 days.

`fast_fetch` fetches one public http(s) URL, strips scripts, styles, and tags,
decodes entities, and caps the text at 4,000 characters on a paragraph or word
boundary. It also audits the raw page and returns
`aeo: {score, signals, optimized}`. It refuses localhost, private address
ranges, `.local`, `.internal`, and non-http(s) schemes, and re-checks the final
URL after redirects.

`final_answer` assembles the output template. It takes `solution`, optional
`code` and `language`, `sources`, and `unverified`, and returns the canonical
markdown. It rejects source URLs that were not returned by `fast_search` or
`fast_fetch` in the same turn, and rejects a missing source unless
`unverified: true` is set.

## AEO-first ranking

`fast_search` scores each result before returning it:

| Signal | Points |
|---|---|
| Official docs host (`docs.*`, `developer.*`, curated set) | +25 |
| GitHub | +10 |
| Docs path (`/docs`, `/reference`, `/api`, `/manual`, `/guide`, `/faq`, ...) | +10 |
| Answer-first snippet | +15 |
| Code snippet | +10 |
| Structured list | +5 |
| Fresh (under 18 months) | +10 |
| Stale (over 5 years) | -10 |
| Query/title token overlap at least 50% | +10 |
| Forum host (Stack Overflow, Reddit, Quora) | -10 |
| Secondary tutorial host | -5 |

A result is `aeo: true` at `QUICK_AGENT_AEO_MIN` (default 40). AEO results sort
first by score; non-AEO results keep the provider order as the fallback.

`fast_fetch` audits the raw page:

| Signal | Points |
|---|---|
| `FAQPage` or `HowTo` JSON-LD | +20 |
| `TechArticle`, `Article`, or `QAPage` JSON-LD | +10 |
| Official host | +10 |
| Meta description 50-300 characters | +5 |
| Question headings | +5 each, max +15 |
| Answer-first first paragraph | +10 |
| Code | +5 |
| List | +5 |
| Fresh | +10 |
| Stale | -5 |

`optimized` is true at `QUICK_AGENT_AEO_PAGE_MIN` (default 25). The agent uses
it to confirm the page; if it is not optimized and does not answer the question,
the next search result is the fallback.

The audit is a heuristic, not a guarantee. A primary source that is not marked
AEO remains valid, and the agent falls back to it when no AEO result answers.

## Output contract enforcement

The template is assembled by the `final_answer` tool, not by the model:

- `solution` is required and capped at 400 characters; long-form detail belongs
  in `explanation`, which is inserted between the solution and the sources.
- `sources` must be in the turn's verified URL set, populated only by
  `fast_search` and `fast_fetch` results. An invented URL throws a `Tool.Error`.
- `unverified: true` emits `None — retrieval failed` and the unverified notice.
  It conflicts with provided sources.
- The tool returns the canonical markdown; the agent is instructed to reply
  with exactly that content.

Explanation requests are detected from the user prompt and use a separate
readability contract instead of the Q&A template:

- short paragraphs of one to three sentences;
- descriptive headings or bullet lists;
- an explicit good-vs-bad contrast;
- no paragraph longer than about 700 characters.

An explanation is not required to carry `**Solution:**`. If it is a dense wall,
the audit asks for a rewrite with `repairExplanationPrompt`, not
`final_answer`.

If the model bypasses the tool or writes a malformed final message, a
turn-completion audit (`session.execution.succeeded`) runs:

1. reads the last assistant text;
2. accepts clarifying questions and explicit `deep-research` escalation
   statuses;
3. validates the headings, order, and every link against the verified URL set;
4. sends at most one repair prompt per turn, marked `quickRepair` so the prompt
   hook keeps the verified URLs.

The repair is a follow-up, user-visible prompt, not an in-place edit: OpenCode
V2 has no public hook for rewriting a stored assistant message, and the
`session.idle` event is ephemeral rather than delivered to plugin streams. The
`final_answer` tool is the deterministic path; the completion audit is the
safety net.

## Circuit breakers

The plugin applies four deterministic gates to `quick` before a network call:

| Gate | Trigger | Result |
|---|---|---|
| Wall clock | more than 18s after the prompt, after the first call | `BUDGET_EXCEEDED` |
| Query dedup | token Jaccard > 0.75 against a query already tried | `DUPLICATE_QUERY` |
| URL dedup | exact URL already fetched this turn | `DUPLICATE_URL` |
| Error streak | two errors or empty payloads in a row | `SOURCE_BLOCKED` for the tool or host |

The first call is never blocked by the wall clock, so a slow first reasoning
step still gets one retrieval. A successful call resets the error streak. A new
user prompt resets the whole turn. The breakers only apply to sessions whose
agent is `quick`; `deep-research` relies on the per-tool timeout and its own
steps cap.

## Install and verify

```bash
bash scripts/install.sh
node scripts/doctor.mjs
node --test plugins/quick-agent/quick-agent.test.mjs
```

Then restart OpenCode if the plugin does not appear in `opencode api get
/api/plugin`. Use `opencode --agent quick` or select `quick` in the TUI.

## Knobs

| Variable | Default | Effect |
|---|---|---|
| `QUICK_AGENT_BUDGET_MS` | `18000` | Retrieval cutoff after the first call |
| `QUICK_AGENT_TOOL_TIMEOUT_MS` | `4000` | Per-network-call timeout |
| `QUICK_AGENT_FETCH_MAX_CHARS` | `4000` | Page text ceiling |
| `QUICK_AGENT_SEARCH_TTL_MS` | 24h | Docs cache TTL |
| `QUICK_AGENT_CLI_TTL_MS` | 7d | CLI cache TTL |
| `QUICK_AGENT_SEARCH_PROVIDER` | `parallel` | OpenCode websearch retry provider |
| `QUICK_AGENT_AEO_MIN` | `40` | Search-result AEO threshold |
| `QUICK_AGENT_AEO_PAGE_MIN` | `25` | Fetched-page AEO threshold |

## Known limits

- The OpenCode websearch API has no cancellation parameter. The 4-second race
  returns a timeout to the model, but the provider call may finish in the
  background.
- The cache has no eviction; entries are small and keyed per normalized query
  or URL.
- Private-address blocking is host-literal based. It does not resolve DNS
  rebinding.
- `deep-research` can use `read`, `grep`, and `glob`, so it can inspect the
  local codebase; `quick` cannot.
- The completion audit cannot rewrite a stored assistant message. It sends one
  repair turn; the `final_answer` tool is the deterministic formatting path.
