import { config as loadEnv } from 'dotenv'

// override: true so .env wins over the surrounding shell. dotenv defaults to
// leaving an already-exported variable alone, which bites on a machine with a
// local LLM gateway: an exported OPENAI_BASE_URL sends Agents API calls to the
// gateway, which does not serve /v1/agents and answers with a plain
// `404 page not found` — a Go default, not an OpenAI error, so it reads as if
// the API rejected the request rather than never having received it.
loadEnv({ override: true })

/**
 * Codex CLI version baked into the template.
 *
 * Pinned deliberately: `@alpha` floats, so two templates built a week apart
 * would ship different executors and diverge in behaviour with no visible
 * cause. Bump this explicitly, rebuild, and re-run `npm run verify`.
 */
export const CODEX_VERSION = '0.155.0-alpha.3'

/** Template alias the build publishes to and the runner creates sandboxes from. */
export const TEMPLATE_NAME =
  process.env.NOVITA_TEMPLATE_NAME || 'openai-agents-api-executor'

/** Workspace the agent operates in. Must match `environment.workspace_directory`. */
export const WORKSPACE_DIR = '/workspace'

/** CODEX_HOME. Kept off /workspace so agent file operations cannot corrupt it. */
export const CODEX_HOME = '/codex-home'

/**
 * Registration endpoint passed to `codex exec-server --remote`.
 *
 * The Agents API also returns a per-session `environment.remote_url`; prefer
 * that when present and fall back to this constant.
 */
export const DEFAULT_REMOTE_URL = 'https://api.openai.com/v1/agents/api'

/**
 * Hosts the executor reaches. Novita sandboxes allow outbound traffic by
 * default, so nothing here needs configuring for the common case.
 *
 * Documented for the caller who deliberately restricts egress: miss either
 * host and the session sits in `environment.pending` until the API's
 * five-minute connect window expires, with nothing in the event stream
 * pointing at the network policy.
 */
export const REQUIRED_EGRESS_HOSTS = [
  'api.openai.com',
  'codex-cloud-environments.chatgpt.com',
] as const

/** Where the executor's output is teed inside the sandbox, for post-mortems. */
export const EXECUTOR_LOG = '/tmp/codex-executor.log'

/**
 * Sandbox lifetime. Independent of any command timeout: an expired sandbox
 * dies even while a command claims to have no deadline.
 */
export const SANDBOX_TIMEOUT_MS = 30 * 60 * 1000

/**
 * The Agents API waits at most five minutes for an input-time connection.
 * A submission that misses the window fails and is not replayed.
 */
// Pause instead of discarding when the sandbox timeout expires: the workspace is
// the point of a self-hosted environment, and reusing an environment id does not
// restore files in replacement compute. autoResume lets the next connect() bring
// it back. Applies to sandboxes whose files outlive one turn, not to throwaways.
export const SANDBOX_LIFECYCLE = {
  onTimeout: 'pause',
  autoResume: true,
} as const

/**
 * Long-running mode: lifts the ceiling on `timeoutMs`.
 *
 * The CLI's `--long-running` flag describes itself as storing a metadata
 * marker, which reads as inert bookkeeping. It is a server-side switch.
 *
 * Measured: without this key the server rejects anything past four hours with
 * `400 Timeout cannot be greater than 4 hours` (three hours is fine). With it,
 * 720 hours is granted exactly. Must be set at creation — `setTimeout()` beyond
 * the ceiling on a sandbox created without it is silently ignored, no error and
 * `endAt` unchanged.
 */
export const LONG_RUNNING_METADATA = { long_running: 'true' } as const

/**
 * Practical ceiling for `timeoutMs`. The wire format is int32 *seconds*, so
 * anything past 2147483647s (~68 years) is rejected outright:
 * `integer doesn't match the format "int32"`. Measured: this value is accepted
 * and yields an endAt in 2094; 100 years is a 400.
 */
export const MAX_TIMEOUT_MS = 2_147_483_647 * 1000

export const CONNECT_DEADLINE_MS = 5 * 60 * 1000

export function requireEnv(name: string): string {
  const value = process.env[name]
  if (!value) {
    throw new Error(
      `${name} is not set. Copy .env.example to .env and fill it in.`
    )
  }
  return value
}

/** Read an env var without asserting, for optional credentials. */
export function optionalEnv(name: string): string | undefined {
  return process.env[name] || undefined
}
