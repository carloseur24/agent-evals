/**
 * report_quality — judges whether the final report carries usable evidence.
 *
 * Input is a compact summary built by `buildJudgeSource` in `lib/score.mjs`:
 * the final report text, files changed, and the deterministic test evidence.
 * The scorer asks the configured judge transport for a 0–1 score.
 */

export const name = 'report_quality';

export const description =
  'Does the final report state status, files changed, checks with commands and actual output, and blockers?';

export const rubric = `You are grading the quality of an agent's final report.

The input is a compact JSON summary:
- case.task: the user instruction the agent received.
- report: the agent's final report text.
- files_changed: the files the workspace actually changed.
- checks: deterministic test evidence (command, exit_code, passed, stdout, stderr).

Apply this scale exactly:

Score 1.0 only when the report contains ALL of these:
1. A clear status (success, partial, blocked, or failed).
2. The files changed by the work (or an explicit statement that none changed).
3. The checks run, each with its command and its actual output.
4. Blockers (or an explicit statement that there were none).

Score 0.5 when a report is present but omits the actual output, the files changed, or the blockers.

Score 0.0 when there is no report evidence, or when the report claims something the deterministic evidence contradicts (for example, claiming tests pass while the captured check exited non-zero).

Judge only the report and evidence in the input. A report that says a command ran but shows no output is missing actual output. A report that says "done" without files, checks, or blockers is not evidence.

Return only strict JSON: {"score": <number from 0 to 1>, "rationale": "<one or two sentences citing specific evidence>"}.`;

/**
 * Project the run summary down to the facts this judge needs.
 *
 * @param {{source: object}} input
 */
export function buildInput({ source }) {
  return {
    case: source?.case ?? null,
    report: source?.final_report ?? '',
    files_changed: source?.files_changed ?? [],
    checks: source?.tests ?? [],
  };
}

/**
 * Ask the configured judge for a score. The judge callable is injected so this
 * module never owns transport or model configuration.
 *
 * @param {{input: object, output?: string, expected?: object, metadata: {judge: Function}}} context
 */
export async function scorer({ input, metadata }) {
  const result = await metadata.judge({ rubric, input });
  return {
    score: result.status === 'ok' ? result.score : null,
    metadata: {
      status: result.status,
      rationale: result.rationale ?? null,
      model: result.model ?? null,
      raw: result.raw ?? null,
      error: result.error ?? null,
    },
  };
}
