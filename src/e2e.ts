/**
 * End-to-end check: one Agents API session executing in a Novita sandbox.
 *
 * Everything except the sandbox side is the official SDK used directly. Reports
 * a timing breakdown, because the API allows only five minutes for an
 * input-time connection and the useful question is which phase consumes it.
 *
 *   npm run e2e
 */
import OpenAI from 'openai'
import { startExecutor } from './runner.js'
import { CONNECT_DEADLINE_MS, WORKSPACE_DIR, requireEnv } from './config.js'

const MODEL = process.env.AGENTS_MODEL || 'gpt-6-astra'
const EXPECTED = 'novita executor ok'

/**
 * Attach to an existing sandbox instead of creating one:
 *
 *   npm run e2e -- --sandbox-id <id>
 *
 * This is the shape a real integration takes — the sandbox already holds the
 * work and the agent is attached to it. Without the flag a throwaway sandbox is
 * created from the template and killed afterwards.
 */
const sandboxIdArg = (() => {
  const index = process.argv.indexOf('--sandbox-id')
  return index === -1 ? undefined : process.argv[index + 1]
})()
const keepSandbox = process.argv.includes('--keep-sandbox')

requireEnv('NOVITA_API_KEY')
const client = new OpenAI({ apiKey: requireEnv('OPENAI_API_KEY') })
const executorApiKey = requireEnv('OPENAI_EXECUTOR_API_KEY')

const marks: Array<[string, number]> = []
const t0 = Date.now()
const mark = (label: string) => marks.push([label, Date.now() - t0])

let sessionId: string | undefined
let executor: Awaited<ReturnType<typeof startExecutor>> | undefined

try {
  console.log('1. Creating self-hosted session')
  const session = await client.beta.agents.sessions.create({
    agent: {
      model: MODEL,
      instructions:
        'You are a coding assistant. Write files in the workspace and verify your work by reading them back.',
    },
    environment: {
      type: 'self_hosted',
      workspace_directory: WORKSPACE_DIR,
    },
  })
  sessionId = session.id

  // The environment is a union across the hosted and self-hosted variants.
  // Narrow it here so an undefined id cannot reach the executor command line.
  const environment = session.environment
  if (environment?.type !== 'self_hosted') {
    throw new Error(
      `Session ${session.id} has no self-hosted environment (got ${environment?.type ?? 'none'}).`
    )
  }
  mark('session created')
  console.log(`   session=${session.id} environment=${environment.id}`)
  console.log(`   remote=${environment.remote_url}`)

  console.log(
    sandboxIdArg
      ? `2. Attaching the executor to sandbox ${sandboxIdArg}`
      : '2. Creating a sandbox and starting the executor'
  )
  executor = await startExecutor({
    ...(sandboxIdArg ? { sandboxId: sandboxIdArg } : {}),
    environmentId: environment.id,
    // Required by the API type and documented as "pass this URL unchanged".
    remoteUrl: environment.remote_url,
    executorApiKey,
    sessionId: session.id,
    onExecutorLog: (line) => console.log(`   [executor] ${line.trimEnd()}`),
  })
  mark('executor started')
  console.log(
    `   sandbox=${executor.sandbox.sandboxId} (${executor.createdSandbox ? 'created' : 'attached'})`
  )

  // Follow the event stream rather than polling the session: an
  // `environment.failed` event is the only place a registration failure is
  // reported, while a retrieve would keep returning `pending` until the
  // five-minute window expired — indistinguishable from a network problem.
  console.log('3. Waiting for the environment to connect')
  const events = await client.beta.agents.sessions.events.stream(session.id, {
    signal: AbortSignal.timeout(CONNECT_DEADLINE_MS),
  })
  let connected = false
  for await (const event of events) {
    if (event.type.startsWith('agent.session.environment.')) {
      console.log(`   ${event.type}`)
    }
    if (event.type === 'agent.session.environment.connected') {
      connected = true
      break
    }
    if (
      event.type === 'agent.session.environment.failed' ||
      event.type === 'agent.session.failed'
    ) {
      throw new Error(
        `${event.type}: ${JSON.stringify(event)}\n` +
          `Check the executor logs. If egress is restricted, allow api.openai.com ` +
          `and codex-cloud-environments.chatgpt.com.`
      )
    }
  }
  if (!connected) {
    throw new Error('Event stream ended before the environment connected.')
  }
  mark('environment connected')

  console.log('4. Sending a task')
  await client.beta.agents.sessions.events.create(session.id, {
    events: [
      {
        type: 'agent.session.input.message',
        input: [
          {
            role: 'user',
            content: [
              {
                type: 'input_text',
                text: `Write a file at ${WORKSPACE_DIR}/hello.txt containing exactly "${EXPECTED}", then read it back and report the contents.`,
              },
            ],
          },
        ],
      },
    ],
  })
  mark('input accepted')

  // Assert against the sandbox filesystem, not the agent's own narration:
  // a turn can report success while the write never landed.
  console.log('5. Checking the workspace for the written file')
  const deadline = Date.now() + 4 * 60 * 1000
  let contents: string | undefined
  while (Date.now() < deadline) {
    contents = await executor.sandbox.files
      .read(`${WORKSPACE_DIR}/hello.txt`)
      .catch(() => undefined)
    if (contents?.includes(EXPECTED)) break
    await new Promise((resolve) => setTimeout(resolve, 5000))
  }
  mark('file observed')

  if (!contents?.includes(EXPECTED)) {
    throw new Error(
      `The agent did not write the expected file. Last read: ${JSON.stringify(contents ?? null)}`
    )
  }
  console.log(`   file contents: ${contents.trim()}`)

  console.log('\nTiming breakdown:')
  let previous = 0
  for (const [label, at] of marks) {
    console.log(`   ${String(at - previous).padStart(7)}ms  ${label}`)
    previous = at
  }
  console.log(`   ${String(previous).padStart(7)}ms  total`)
  console.log('\nPASS')
} catch (error) {
  console.error('\nFAIL')
  console.error(error instanceof Error ? error.stack : error)
  process.exitCode = 1
} finally {
  // Session deletion and compute teardown are separate: deleting a session
  // does not stop its environment. stop() only kills a sandbox this run created,
  // so an attached sandbox survives either way.
  if (executor && keepSandbox) {
    console.log(
      `\nSandbox ${executor.sandbox.sandboxId} left running for inspection ` +
        `(executor log: /tmp/codex-executor.log). Kill it when done.`
    )
  } else {
    await executor?.stop().catch((error: unknown) =>
      console.error('sandbox teardown failed:', error)
    )
  }
  if (sessionId) {
    await client.beta.agents.sessions
      .delete(sessionId)
      .catch((error: unknown) => console.error('session delete failed:', error))
  }
}
