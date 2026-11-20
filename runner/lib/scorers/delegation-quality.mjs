/**
 * delegation_quality — judges whether an orchestrator delegated a plan correctly.
 *
 * Input is a compact summary built by `buildJudgeSource` in `lib/score.mjs`:
 * case task, plan, parent trajectory, child delegations, and final gate.
 * The scorer asks the configured judge transport for a 0–1 score.
 */

export const name = 'delegation_quality';

export const description =
  'Was every plan phase delegated separately with plan path, tasks, acceptance criteria, scope, checks, and the final gate?';

export const rubric = `You are grading whether an orchestrator delegated a multi-phase plan correctly.

The input is a compact JSON summary of one run:
- case.task: the user instruction the parent received.
- plan: the plan file (path, phase headings, content) or null.
- parent: the parent trajectory summary (code_edit_calls, shell_calls, subagent_calls, other_tool_calls, final_report).
- children: one entry per child delegation (agent, prompt, final_report, tool_calls).
- final_gate: whether a child ran the plan's final gate and its exit code.

Apply this scale exactly:

Score 1.0 only when ALL of these hold:
1. Every phase in the plan was delegated in its own separate subagent call.
2. Each delegation prompt names the plan path and the exact phase heading.
3. Each delegation prompt lists the phase tasks and acceptance criteria.
4. Each delegation prompt states the files/directories in scope and what must not be touched.
5. Each delegation prompt states the checks to run and the expected output.
6. The plan's final gate was delegated to a child and passed.
7. The parent made no code edits and no shell calls.

Score 0.6 when phases were delegated separately but one required element above is missing, or when the final plan gate was not delegated.

Score 0.0 when the parent edited code or ran shell commands, when phases were batched into one vague delegation, or when no child did a phase.

Judge only the evidence in the input. Do not infer work that is not shown. Missing evidence is a missing required element. A delegation that merely repeats the phase name without tasks, scope, non-scope, checks, or acceptance criteria is vague, not complete.

Return only strict JSON: {"score": <number from 0 to 1>, "rationale": "<one or two sentences citing specific evidence>"}.`;

/**
 * Project the run summary down to the facts this judge needs.
 *
 * @param {{source: object}} input
 */
export function buildInput({ source }) {
  const parent = source?.parent ?? {};
  const children = Array.isArray(source?.children) ? source.children : [];

  return {
    case: source?.case ?? null,
    plan: source?.plan ?? null,
    parent: {
      agent: parent.agent ?? null,
      code_edit_calls: Number(parent.code_edit_calls ?? 0),
      shell_calls: Number(parent.shell_calls ?? 0),
      subagent_calls: parent.subagent_calls ?? [],
      other_tool_calls: parent.other_tool_calls ?? [],
      final_report: parent.final_report ?? '',
    },
    children: children.map((child) => ({
      agent: child.agent ?? null,
      title: child.title ?? null,
      prompt: child.prompt ?? '',
      final_report: child.final_report ?? '',
      tool_calls: child.tool_calls ?? [],
    })),
    final_gate: source?.final_gate ?? null,
    files_changed: source?.files_changed ?? [],
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
