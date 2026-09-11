/**
 * Starts a Novita sandbox from the executor template and connects
 * `codex exec-server` to one Agents API session.
 *
 * One executor serves one session: the environment id only exists once the
 * session is created, so the executor cannot be pre-warmed or baked into the
 * template. All traffic is outbound; nothing listens on an inbound port.
 */
import { Sandbox } from 'novita-sandbox'
import type { CommandHandle } from 'novita-sandbox'
import {
  CODEX_HOME,
  EXECUTOR_LOG,
  SANDBOX_TIMEOUT_MS,
  TEMPLATE_NAME,
  WORKSPACE_DIR,
} from './config.js'

export interface ExecutorOptions {
  /** `session.environment.id` returned by the Agents API. */
  environmentId: string
  /**
   * Attach to a sandbox that already exists instead of creating one.
   *
   * This is the common case: the sandbox holds the work — a checkout, running
   * services, files from earlier turns — and the agent is attached to it. A
   * paused sandbox is resumed, keeping its filesystem. Omit to create a fresh
   * sandbox from the template, which is only right for throwaway work.
   */
  sandboxId?: string
  /** `session.environment.remote_url`. Pass through unchanged, including on reconnect. */
  remoteUrl: string
  /** Restricted OpenAI environment key. The only credential that enters the sandbox. */
  executorApiKey: string
  /** Defaults to SANDBOX_TIMEOUT_MS. */
  sandboxTimeoutMs?: number
  /** Stored on the sandbox for reconciliation. */
  sessionId?: string
  onExecutorLog?: (line: string) => void
}

export interface RunningExecutor {
  sandbox: Sandbox
  handle: CommandHandle
  /** True when this call created the sandbox rather than attaching to one. */
  createdSandbox: boolean
  /**
   * Stops the executor. Kills the sandbox only if this call created it, so
   * attaching an agent to a caller's sandbox never destroys their work.
   */
  stop: () => Promise<void>
}

/** POSIX single-quote escaping. The command string is evaluated by a shell. */
function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`
}

export async function startExecutor(
  options: ExecutorOptions
): Promise<RunningExecutor> {
  const {
    environmentId,
    remoteUrl,
    executorApiKey,
    sessionId,
    onExecutorLog,
    sandboxTimeoutMs = SANDBOX_TIMEOUT_MS,
  } = options

  // No network configuration: Novita sandboxes allow outbound traffic by
  // default, so the executor reaches OpenAI as-is (measured: api.openai.com and
  // codex-cloud-environments.chatgpt.com are both reachable from inside a
  // sandbox). Only a caller that deliberately restricts egress needs to
  // allowlist REQUIRED_EGRESS_HOSTS, and that is their policy, not ours.
  const createdSandbox = !options.sandboxId
  const sandbox = options.sandboxId
    ? // connect() resumes a paused sandbox and keeps its files.
      await Sandbox.connect(options.sandboxId)
    : await Sandbox.create(TEMPLATE_NAME, {
        // Sandbox lifetime is its own clock, unrelated to any command timeout.
        // Novita kills the sandbox when this expires, which also bounds a
        // leaked executor if the caller crashes.
        timeoutMs: sandboxTimeoutMs,
        metadata: {
          purpose: 'openai-agents-api-executor',
          environmentId,
          ...(sessionId ? { sessionId } : {}),
        },
      })

  if (!createdSandbox) {
    // Extend a borrowed sandbox so it outlives the turn, without assuming
    // anything about how long its owner wanted it.
    await sandbox.setTimeout(sandboxTimeoutMs).catch(() => {})
  }

  try {
    if (!createdSandbox) {
      // A caller's sandbox may not be built from the executor template, and a
      // missing binary would otherwise surface as a session stuck in
      // `environment.pending` — indistinguishable from a network problem.
      const probe = await sandbox.commands
        .run('command -v codex', { timeoutMs: 30_000 })
        .catch(() => undefined)
      if (!probe?.stdout.trim()) {
        throw new Error(
          `Sandbox ${sandbox.sandboxId} has no codex binary on PATH. Build it from ` +
            `the executor template, or install @openai/codex inside it first.`
        )
      }
    }

    // The executor is a long-lived process, so it must run in the background:
    // `commands.run` defaults to a 60s timeout, which would kill it at 61s and
    // surface as an unrelated channel error. Background start reads only the
    // first frame (the pid) and leaves the process running.
    const command = [
      `cd ${shellQuote(WORKSPACE_DIR)}`,
      [
        'exec codex exec-server',
        `--remote ${shellQuote(remoteUrl)}`,
        `--environment-id ${shellQuote(environmentId)}`,
        // Tee rather than redirect: the caller still gets a live stream through
        // onExecutorLog, and the file survives for inspection afterwards, which
        // is the only place a registration failure is reported.
        `2>&1 | tee ${shellQuote(EXECUTOR_LOG)}`,
      ].join(' '),
    ].join(' && ')

    const handle = await sandbox.commands.run(command, {
      background: true,
      // Passed here as well as at creation: a process started through the
      // commands API only sees the env this call sends.
      envs: {
        CODEX_API_KEY: executorApiKey,
        CODEX_HOME,
      },
      onStdout: onExecutorLog,
      onStderr: onExecutorLog,
    })

    return {
      sandbox,
      handle,
      createdSandbox,
      stop: async () => {
        try {
          await handle.kill()
        } catch {
          // Already gone, or the sandbox died first.
        }
        // Only tear down what we brought. A caller's own sandbox is left
        // running with its files intact.
        if (createdSandbox) await sandbox.kill()
      },
    }
  } catch (error) {
    // Never leave compute running behind a failed start — but only compute this
    // call created.
    if (createdSandbox) await sandbox.kill().catch(() => {})
    throw error
  }
}
