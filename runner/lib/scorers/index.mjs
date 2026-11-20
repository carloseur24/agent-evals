/**
 * Scorer registry.
 *
 * A case opts into qualitative scoring by naming a scorer:
 *
 *   "judges": { "delegation_quality": { "threshold": 0.6 } }
 *
 * Every scorer module exports the same contract:
 *
 *   name        unique registry key used by case JSON
 *   description one-line explanation for reports and CLI listings
 *   rubric      prompt text the judge applies
 *   buildInput  ({ source }) => compact JSON payload for the judge
 *   scorer      async ({ input, output, expected, metadata }) =>
 *                 { score, metadata: { status, rationale, model, raw, error } }
 *
 * `metadata.judge` is injected by `lib/judge.mjs`; scorers never own transport,
 * model, temp files, or parsing. Scores are advisory and never touch hard checks.
 */

import * as delegationQuality from './delegation-quality.mjs';
import * as reportQuality from './report-quality.mjs';

const DEFINITIONS = new Map([
  [delegationQuality.name, delegationQuality],
  [reportQuality.name, reportQuality],
]);

/** @param {string} name */
export function getScorer(name) {
  const definition = DEFINITIONS.get(String(name));
  if (!definition) {
    const known = [...DEFINITIONS.keys()].join(', ');
    throw new Error(`unknown scorer "${name}" (known: ${known})`);
  }
  return definition;
}

/** Registry listing for help text and calibration summaries. */
export function listScorers() {
  return [...DEFINITIONS.values()].map((definition) => ({
    name: definition.name,
    description: definition.description,
  }));
}

export const scorerNames = Object.freeze([...DEFINITIONS.keys()]);
