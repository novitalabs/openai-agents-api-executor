/**
 * The shape a real integration takes: a sandbox exists and holds the work, then
 * an agent is attached to it.
 *
 * This is the opposite order from `e2e.ts`, which creates a throwaway sandbox
 * per session to check the plumbing. Here the sandbox comes first, is seeded
 * with a repository-like workspace, and survives after the agent is done — so
 * later turns, or a different agent, can pick up where this one left off.
 *
 *   npm run example                      # create a sandbox, use it, keep it
 *   npm run example -- --sandbox-id <id> # reuse one from a previous run
 */
import OpenAI from 'openai'
import { Sandbox } from 'novita-sandbox'
import { startExecutor } from './runner.js'
import {
  CONNECT_DEADLINE_MS,
  EXECUTOR_LOG,
  SANDBOX_LIFECYCLE,
  SANDBOX_TIMEOUT_MS,
  TEMPLATE_NAME,
  WORKSPACE_DIR,
  requireEnv,
} from './config.js'

const MODEL = process.env.AGENTS_MODEL || 'gpt-6-astra'
const TASK =
  process.env.AGENT_TASK ||
  `Read ${WORKSPACE_DIR}/notes.md, then write a file ${WORKSPACE_DIR}/summary.md ` +
    `that lists each TODO it contains as a checklist. Verify by reading it back.`

const existingSandboxId = (() => {
  const index = process.argv.indexOf('--sandbox-id')
  return index === -1 ? undefined : process.argv[index + 1]
})()

requireEnv('NOVITA_API_KEY')
const client = new OpenAI({ apiKey: requireEnv('OPENAI_API_KEY') })
const executorApiKey = requireEnv('OPENAI_EXECUTOR_API_KEY')

// ---------------------------------------------------------------------------
// 1. The sandbox, and the work already in it.
//
// In a real integration this is where a checkout is cloned, dependencies are
// installed, or files from a previous turn already live. The agent is a visitor
// to this workspace, not its owner.
// ---------------------------------------------------------------------------
let sandbox: Sandbox
if (existingSandboxId) {
  // connect() resumes a paused sandbox with its filesystem intact.
  sandbox = await Sandbox.connect(existingSandboxId)
  await sandbox.setTimeout(SANDBOX_TIMEOUT_MS)
  console.log(`Reusing sandbox ${sandbox.sandboxId}`)
} else {
  sandbox = await Sandbox.create(TEMPLATE_NAME, {
    timeoutMs: SANDBOX_TIMEOUT_MS,
    lifecycle: SANDBOX_LIFECYCLE,
    metadata: { purpose: 'agents-api-example' },
  })
  console.log(`Created sandbox ${sandbox.sandboxId}`)
  await sandbox.files.write(
    `${WORKSPACE_DIR}/notes.md`,
    [
      '# Project notes',
      '',
      '- TODO: pin the codex version in the template',
      '- TODO: allow egress to the two OpenAI hosts when restricted',
      '- Done: bake the CLI into the image',
      '',
    ].join('\n')
  )
  console.log(`Seeded ${WORKSPACE_DIR}/notes.md`)
}

// ---------------------------------------------------------------------------
// 2. A session for this sandbox.
//
// The environment is assigned by the API, one per session; it cannot be created
// or pooled in advance. `workspace_directory` must match where the work is.
// ---------------------------------------------------------------------------
const session = await client.beta.agents.sessions.create({
  agent: {
    model: MODEL,
    instructions:
      'You are working in an existing project directory. Use the shell to inspect ' +
      'files before changing them, and verify your work by reading it back.',
  },
  environment: { type: 'self_hosted', workspace_directory: WORKSPACE_DIR },
})
const environment = session.environment
if (environment?.type !== 'self_hosted') {
  throw new Error(`Session ${session.id} is not self-hosted`)
}
console.log(`Session ${session.id} -> environment ${environment.id}`)

// ---------------------------------------------------------------------------
// 3. Attach the executor to the sandbox that already exists.
//
// `stop()` will not kill it, because this run did not create it — except on the
// first run, where the flag below keeps it anyway.
// ---------------------------------------------------------------------------
const executor = await startExecutor({
  sandboxId: sandbox.sandboxId,
  environmentId: environment.id,
  remoteUrl: environment.remote_url,
  executorApiKey,
  sessionId: session.id,
  onExecutorLog: (line) => console.error(`  [executor] ${line.trimEnd()}`),
})

try {
  // Open the stream before sending input, so the connection wait is observable
  // rather than a silent five minutes.
  const events = await client.beta.agents.sessions.events.stream(session.id, {
    signal: AbortSignal.timeout(CONNECT_DEADLINE_MS),
  })

  await client.beta.agents.sessions.events.create(session.id, {
    events: [
      {
        type: 'agent.session.input.message',
        input: [{ role: 'user', content: [{ type: 'input_text', text: TASK }] }],
      },
    ],
  })

  for await (const event of events) {
    switch (event.type) {
      case 'agent.session.environment.connected':
        console.error('  [environment connected]')
        break

      case 'agent.session.environment.failed':
        throw new Error(
          `Environment failed. Read ${EXECUTOR_LOG} in ${sandbox.sandboxId}: ${JSON.stringify(event)}`
        )

      case 'agent.session.turn.output_text.delta':
        process.stdout.write(event.delta)
        break

      case 'agent.session.turn.completed':
        process.stdout.write('\n')
        break

      case 'agent.session.turn.failed':
      case 'agent.session.failed':
        throw new Error(`${event.type}: ${JSON.stringify(event)}`)
    }
    if (event.type === 'agent.session.turn.completed') break
  }

  // Trust the filesystem, not the narration: a turn can report success while
  // the write never landed.
  const summary = await sandbox.files
    .read(`${WORKSPACE_DIR}/summary.md`)
    .catch(() => undefined)
  console.log('\n--- summary.md as it exists in the sandbox ---')
  console.log(summary ?? '(not written)')
} finally {
  // Release the session and the executor, but leave the sandbox: its files are
  // the point, and the next turn can reuse them.
  await executor.stop().catch(() => {})
  await client.beta.agents.sessions.delete(session.id).catch(() => {})
  console.log(
    `\nSandbox ${sandbox.sandboxId} is still running with your files.\n` +
      `  reuse: npm run example -- --sandbox-id ${sandbox.sandboxId}\n` +
      `  executor log: ${EXECUTOR_LOG}`
  )
}
