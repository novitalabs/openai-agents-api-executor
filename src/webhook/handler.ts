/**
 * Webhook controller. Runs inside its own Novita sandbox, reachable at the
 * sandbox host for CONTROLLER_PORT.
 *
 * Two jobs, deliberately split:
 *
 *  1. Verify and queue. The HTTP handler verifies the signature, queues the
 *     session id, and only then returns 200. Nothing slow happens on the request
 *     path, so OpenAI never waits on sandbox provisioning.
 *  2. Reconcile. A worker drains the queue, re-reads the session from the API,
 *     and acts only if the action is still pending. Re-reading is what makes a
 *     duplicate or stale delivery harmless.
 *
 * Deployed by deploy.ts; not meant to be run directly on a laptop.
 */
import { createServer } from 'node:http'
import { appendFileSync } from 'node:fs'
import OpenAI from 'openai'
import { Sandbox } from 'novita-sandbox'
import {
  CONTROLLER_LOG,
  CONTROLLER_PORT,
  EXECUTOR_LOG,
  SANDBOX_LIFECYCLE,
  SESSION_METADATA_KEY,
  TEMPLATE_NAME,
  WORKER_TIMEOUT_MS,
  WORKSPACE_DIR,
} from './config.js'

const OPENAI_API_KEY = requireEnv('OPENAI_API_KEY')
const EXECUTOR_API_KEY = requireEnv('OPENAI_EXECUTOR_API_KEY')
const WEBHOOK_SECRET = process.env.OPENAI_WEBHOOK_SECRET || ''
// Scope the controller to one agent, so several controllers can share a
// project without fighting over each other's sessions.
const AGENT_ID = process.env.OPENAI_AGENT_ID || ''

function requireEnv(name: string): string {
  const value = process.env[name]
  if (!value) throw new Error(`${name} is not set in the controller environment`)
  return value
}

const client = new OpenAI({ apiKey: OPENAI_API_KEY })

function log(event: string, fields: Record<string, unknown> = {}): void {
  const line = JSON.stringify({ at: new Date().toISOString(), event, ...fields })
  console.log(line)
  try {
    appendFileSync(CONTROLLER_LOG, line + '\n')
  } catch {
    // Logging must never break reconciliation.
  }
}

/**
 * In-process queue, serialised per session.
 *
 * Serialising per session is the point: two deliveries for one session must not
 * both create a worker. Sessions still reconcile concurrently.
 */
const inFlight = new Map<string, Promise<void>>()

function enqueue(sessionId: string, task: () => Promise<void>): void {
  const previous = inFlight.get(sessionId) ?? Promise.resolve()
  const next = previous
    .then(task)
    .catch((error: unknown) =>
      log('reconcile_failed', { sessionId, error: String(error) })
    )
    .finally(() => {
      if (inFlight.get(sessionId) === next) inFlight.delete(sessionId)
    })
  inFlight.set(sessionId, next)
}

/** Find this session's worker, running or paused. */
async function findWorker(sessionId: string) {
  const paginator = Sandbox.list({
    query: { metadata: { [SESSION_METADATA_KEY]: sessionId } },
  })
  const items = await paginator.nextItems()
  return items.at(0)
}

/**
 * Start `codex exec-server` in a worker.
 *
 * Background start is mandatory: `commands.run` defaults to a 60s timeout and
 * would kill this long-lived process at 61 seconds, surfacing as an unrelated
 * channel error. Output goes to a file in the worker so a failed registration
 * can be read afterwards — it is not reported in any HTTP status.
 */
async function launchExecutor(
  sandbox: Sandbox,
  environmentId: string,
  remoteUrl: string
): Promise<void> {
  const command = [
    `cd ${shellQuote(WORKSPACE_DIR)}`,
    [
      'exec codex exec-server',
      `--remote ${shellQuote(remoteUrl)}`,
      `--environment-id ${shellQuote(environmentId)}`,
      `>${shellQuote(EXECUTOR_LOG)} 2>&1`,
    ].join(' '),
  ].join(' && ')

  await sandbox.commands.run(command, {
    background: true,
    // A build-layer ENV does not reach processes started through the commands
    // API, so CODEX_HOME has to travel with the command.
    envs: { CODEX_API_KEY: EXECUTOR_API_KEY, CODEX_HOME: '/codex-home' },
  })
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`
}

/** Re-read the session and connect an environment only if still needed. */
async function reconcileConnection(sessionId: string): Promise<void> {
  const session = await client.beta.agents.sessions
    .retrieve(sessionId)
    .catch((error: unknown) => {
      // A deleted session is a normal outcome, not a failure to retry.
      log('session_gone', { sessionId, error: String(error) })
      return undefined
    })
  if (!session) return

  if (AGENT_ID && session.agent?.id !== AGENT_ID) {
    log('skipped_other_agent', { sessionId, agent: session.agent?.id })
    return
  }

  // Plural here, singular on the webhook payload above: the delivery carries one
  // `required_action`, the session exposes a `required_actions` array.
  const pending = session.required_actions.find(
    (action) => action.type === 'environment_connection'
  )
  if (!pending) {
    // Resolved between delivery and reconciliation. Starting a worker now would
    // leak compute nothing is waiting for.
    log('action_resolved', { sessionId, status: session.status })
    return
  }

  const environment = session.environment
  if (environment?.type !== 'self_hosted') {
    log('not_self_hosted', { sessionId, type: environment?.type })
    return
  }

  const existing = await findWorker(sessionId)
  let sandbox: Sandbox

  if (existing) {
    // connect() resumes a paused sandbox and keeps its files. A replacement
    // would start empty: reusing the environment id does not restore them.
    sandbox = await Sandbox.connect(existing.sandboxId)
    await sandbox.setTimeout(WORKER_TIMEOUT_MS)
    log('worker_resumed', { sessionId, sandbox: sandbox.sandboxId })
  } else {
    sandbox = await Sandbox.create(TEMPLATE_NAME, {
      timeoutMs: WORKER_TIMEOUT_MS,
      lifecycle: SANDBOX_LIFECYCLE,
      metadata: { [SESSION_METADATA_KEY]: sessionId },
    })
    log('worker_created', { sessionId, sandbox: sandbox.sandboxId })
  }

  await launchExecutor(sandbox, environment.id, environment.remote_url)
  log('executor_started', {
    sessionId,
    sandbox: sandbox.sandboxId,
    environment: environment.id,
  })
}

/**
 * Handle a failed session by pausing its worker rather than killing it.
 *
 * Pausing preserves the filesystem, so the executor log can be read after the
 * fact. Whoever inspects it is responsible for killing it.
 */
async function reconcileFailure(sessionId: string): Promise<void> {
  const worker = await findWorker(sessionId)
  if (!worker) {
    log('no_worker_to_pause', { sessionId })
    return
  }
  const sandbox = await Sandbox.connect(worker.sandboxId)
  await sandbox.pause()
  log('worker_paused', { sessionId, sandbox: sandbox.sandboxId })
}

const server = createServer((request, response) => {
  if (request.method !== 'POST' || !request.url?.startsWith('/webhook')) {
    response.writeHead(404).end(JSON.stringify({ error: 'Not found' }))
    return
  }

  const chunks: Buffer[] = []
  request.on('data', (chunk: Buffer) => chunks.push(chunk))
  request.on('end', () => {
    void (async () => {
      const body = Buffer.concat(chunks).toString('utf8')

      if (!WEBHOOK_SECRET) {
        // Distinct from a signature failure: the secret only exists after the
        // webhook is registered, so the first deploy legitimately runs without it.
        response.writeHead(503, { 'content-type': 'application/json' })
        response.end(JSON.stringify({ error: 'Webhook not configured' }))
        return
      }

      try {
        await client.webhooks.verifySignature(
          body,
          request.headers as Record<string, string>,
          WEBHOOK_SECRET
        )
      } catch (error) {
        log('invalid_signature', { error: String(error) })
        response.writeHead(400, { 'content-type': 'application/json' })
        response.end(JSON.stringify({ error: 'Invalid signature' }))
        return
      }

      // Parsed by hand: `webhooks.unwrap()` narrows to a union that does not
      // include the agent.session.* events.
      let event: { type?: string; data?: Record<string, unknown> }
      try {
        event = JSON.parse(body)
      } catch {
        response.writeHead(400).end(JSON.stringify({ error: 'Invalid JSON' }))
        return
      }

      const sessionId =
        typeof event.data?.id === 'string' ? event.data.id : undefined
      const requiredActionType = (
        event.data?.required_action as { type?: string } | undefined
      )?.type

      if (
        event.type === 'agent.session.action_required' &&
        sessionId &&
        requiredActionType === 'environment_connection'
      ) {
        // A `function_call` action needs a function result, not compute.
        enqueue(sessionId, () => reconcileConnection(sessionId))
        log('enqueued', { sessionId, type: event.type })
      } else if (event.type === 'agent.session.failed' && sessionId) {
        enqueue(sessionId, () => reconcileFailure(sessionId))
        log('enqueued', { sessionId, type: event.type })
      } else {
        log('ignored', { type: event.type, requiredActionType })
      }

      // Returned only after queuing succeeded: a 200 tells OpenAI the event is
      // accounted for, and there is no redelivery to fall back on.
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end(JSON.stringify({ ok: true }))
    })()
  })
})

// Overridable so the controller can be exercised locally on a free port. In a
// sandbox it must stay CONTROLLER_PORT, which is the port deploy.ts exposes.
const port = Number(process.env.CONTROLLER_PORT || CONTROLLER_PORT)

server.listen(port, () => {
  log('controller_listening', {
    port,
    template: TEMPLATE_NAME,
    agentId: AGENT_ID || null,
    signatureVerification: WEBHOOK_SECRET ? 'enabled' : 'pending-secret',
  })
})
