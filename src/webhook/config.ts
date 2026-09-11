/**
 * Configuration shared by the controller, its deploy script, and the client.
 */
import {
  CODEX_VERSION,
  EXECUTOR_LOG,
  LONG_RUNNING_METADATA,
  MAX_TIMEOUT_MS,
  SANDBOX_LIFECYCLE,
  TEMPLATE_NAME,
  WORKSPACE_DIR,
} from '../config.js'

export {
  CODEX_VERSION,
  EXECUTOR_LOG,
  LONG_RUNNING_METADATA,
  MAX_TIMEOUT_MS,
  SANDBOX_LIFECYCLE,
  TEMPLATE_NAME,
  WORKSPACE_DIR,
}

/** Port the controller's HTTP server listens on inside its sandbox. */
export const CONTROLLER_PORT = 8000

/** Metadata marking the controller sandbox, so deploy can find and reuse it. */
export const CONTROLLER_METADATA = {
  'agents-webhook-controller': 'novita',
} as const

/** Metadata key mapping a worker sandbox back to its Agents API session. */
export const SESSION_METADATA_KEY = 'agents-session-id'

/** Where the controller writes its log inside its sandbox. */
export const CONTROLLER_LOG = '/app/controller.log'

/**
 * The controller process's own stdout/stderr, kept separate from the structured
 * log above. A crash writes its stack trace here and nowhere else: the
 * structured log only holds what the handler chose to record, so it simply
 * stops mid-stream when the process dies.
 */
export const CONTROLLER_STDIO = '/app/controller.stdio.log'

/**
 * Worker lifetime. Refreshed when a worker is resumed, so a session that keeps
 * receiving input keeps its files.
 */
export const WORKER_TIMEOUT_MS = 30 * 60 * 1000

/** Controller lifetime, extended by every deploy. */
/**
 * Controller lifetime. Set to the platform maximum with long-running mode on,
 * because the sandbox id is part of the webhook URL registered with OpenAI:
 * losing the sandbox means re-registering the webhook by hand. Extended by
 * every deploy regardless.
 */
export const CONTROLLER_TIMEOUT_MS = MAX_TIMEOUT_MS

/**
 * Webhook events the controller needs.
 *
 * `action_required` is the only event that arrives early enough to start an
 * offline executor: turn creation and `in_progress` are both too late.
 */
export const WEBHOOK_EVENTS = [
  'agent.session.action_required',
  'agent.session.failed',
] as const
