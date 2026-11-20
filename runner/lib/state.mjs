/**
 * Local machine state lives outside the repository.
 *
 * Override with AGENT_EVALS_STATE; the default is ~/.local/state/agent-evals.
 * Reports, drafts, the guard log, and AGENTS backups are never committed.
 */
import os from 'node:os';
import path from 'node:path';

export const STATE_ROOT = path.resolve(
  process.env.AGENT_EVALS_STATE ||
    path.join(os.homedir(), '.local', 'state', 'agent-evals'),
);
export const REPORTS_DIR = path.join(STATE_ROOT, 'reports');
export const DRAFTS_DIR = path.join(STATE_ROOT, 'drafts');
export const BACKUPS_DIR = path.join(STATE_ROOT, 'backups');
export const GUARD_LOG = path.join(STATE_ROOT, 'harness-guard.log');
