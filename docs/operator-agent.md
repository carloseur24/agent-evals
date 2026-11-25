# Operator agent

`agents/operator.md` answers terminal and CLI questions in one turn: one
sentence, one command, no retrieval, no citations. It exists because `quick`
answers those questions correctly but pays for a source, a template, and an
explanation the user did not ask for.

## Files

```text
agents/operator.md           primary, steps: 3, model variant #low, no tools
docs/operator-agent.md       this file
scripts/install.sh           publishes agents/operator.md as a link
```

## Contract

1. One sentence, then one fenced code block. Twelve lines maximum.
2. One command when one command solves it. No verification steps, alternatives,
   or cleanup advice.
3. Identifiers copied byte-for-byte from the user's message.
4. Trigger-word ambiguity gets one `question`, then a stop.
5. No search, no fetch, no file access, no invented URL.

`operator` has no formatter tool. `quick`'s `final_answer` tool exists to
enforce citations; with no retrieval there is nothing to cite, and the template
itself was the source of the filler sections.

## Why a second agent

| | `quick` | `operator` |
|---|---|---|
| Tools | `fast_search`, `fast_fetch`, `final_answer`, `subagent` | `question` only |
| Steps | 6 | 3 |
| Source required | yes | no |
| Best for | library syntax, docs, CLI flags that may have changed | git, shell, ssh, docker, one-liners known cold |
| Failure mode | over-searches and over-explains | cannot verify recent changes |

`quick` cannot be made terse by prompt alone: its contract requires a verified
URL, so every answer pays a search round trip. `operator` drops the requirement
instead of negotiating with it.

## V2 mapping

| Intent | Implemented |
|---|---|
| No tools except clarification | `permissions`: `*` denied, `question` allowed |
| Forced short answer | `steps: 3` — the final step strips tools and asks for text |
| Fast, low-reasoning model | `model` variant `#low` |
| Literal fidelity and disambiguation | system prompt sections |
| Answer length | prompt cap; no formatter to pad |

`temperature` is a legacy V1 field and is not used. There is no per-agent output
token cap in V2, so length is prompt-enforced and measured by evals.

## Evidence

A real session on the `quick` contract produced four failures in one task:

1. The user typed `app.example.com/feat-example-branch`; `quick` declared the
   real branch was "almost certainly" the prefix-stripped form, and the fetch
   failed.
2. "Pull cleanly without linking local branches" had three readings: no
   tracking ref, no merge commit, or no branch adoption. `quick` picked one and
   answered, and the actual goal appeared three turns later.
3. The fix was one `git switch -c` command; the answer carried roughly 700
   tokens of verification and advisory prose.
4. Two `final_answer` rejections came from carrying citations across turns.

Each failure maps to one rule: literal fidelity, disambiguation, length cap, and
no citations.

## Metrics

| Metric | Target |
|---|---|
| Tokens per answer | ≤ 150 |
| User turns to a working fix | ≤ 2 |
| Prefix-stripped identifiers | 0 per 50 answers |
| Clarifying questions on plainly specified prompts | 0 |

## Install and verify

```bash
bash scripts/install.sh
node scripts/doctor.mjs
```

Then use `opencode --agent operator` or select `operator` in the TUI. No
`opencode.json` change is needed.

## Known limits

- No retrieval, so a deprecated flag or a renamed API is answered from memory.
  Route version-sensitive questions to `quick` or `deep-research`.
- `steps: 3` leaves room for one `question` plus the answer. A second
  clarification in the same turn is cut off by the step cap.
- Length is enforced by prompt, not by config; the eval case is the only
  regression test.
