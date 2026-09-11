/**
 * The application side of webhook-managed provisioning.
 *
 * Never imports the sandbox SDK: creating and connecting compute is entirely
 * the controller's job. This process only creates sessions, sends input, and
 * streams the turn.
 *
 *   npm run webhook:client -- --create-agent <name> [--instructions "..."] [--model <id>]
 *   npm run webhook:client -- --update-agent <id> [--instructions "..."] [--model <id>]
 *   npm run webhook:client -- --agent-id <id> --input "..."
 *   npm run webhook:client -- --session-id <id> --input "..."
 *   npm run webhook:client -- --session-id <id> --delete
 */
import OpenAI from 'openai'
import { requireEnv } from '../config.js'
import { WORKSPACE_DIR } from './config.js'

const MODEL = process.env.AGENTS_MODEL || 'gpt-6-astra'

function arg(name: string): string | undefined {
  const index = process.argv.indexOf(`--${name}`)
  return index === -1 ? undefined : process.argv[index + 1]
}
const has = (name: string) => process.argv.includes(`--${name}`)

const client = new OpenAI({ apiKey: requireEnv('OPENAI_API_KEY') })

const DEFAULT_INSTRUCTIONS =
  'You are a coding assistant. Use the shell to do real work in the workspace, and verify results by reading files back.'

if (has('create-agent')) {
  // The SDK types describe `instructions` as appended to the agent's base
  // instructions rather than replacing them; the configuration guide does not
  // say either way, so do not rely on it to suppress default behaviour.
  const agent = await client.beta.agents.create({
    name: arg('create-agent'),
    model: arg('model') || MODEL,
    instructions: arg('instructions') || DEFAULT_INSTRUCTIONS,
  })
  console.log(JSON.stringify({ agent_id: agent.id }))
  process.exit(0)
}

if (has('update-agent')) {
  // Editing in place keeps the agent id, so the controller keeps matching and
  // needs no redeploy. Omitted fields are left unchanged.
  const agent = await client.beta.agents.update(arg('update-agent')!, {
    ...(arg('instructions') ? { instructions: arg('instructions') } : {}),
    ...(arg('model') ? { model: arg('model') } : {}),
    ...(arg('name') ? { name: arg('name') } : {}),
  })
  console.log(
    JSON.stringify({ agent_id: agent.id, model: agent.model, name: agent.name })
  )
  process.exit(0)
}

if (has('delete')) {
  const sessionId = arg('session-id')
  if (!sessionId) throw new Error('--delete needs --session-id')
  await client.beta.agents.sessions.delete(sessionId)
  // Deleting a session does not stop its worker and emits no webhook, so the
  // sandbox has to be released separately.
  console.log(
    JSON.stringify({ deleted: sessionId, note: 'kill the worker sandbox separately' })
  )
  process.exit(0)
}

const input = arg('input')
if (!input) throw new Error('--input is required')

let sessionId = arg('session-id')

if (!sessionId) {
  const agentId = arg('agent-id') || process.env.OPENAI_AGENT_ID
  if (!agentId) {
    throw new Error('provide --agent-id, OPENAI_AGENT_ID, or --session-id')
  }
  const session = await client.beta.agents.sessions.create({
    agent_id: agentId,
    environment: { type: 'self_hosted', workspace_directory: WORKSPACE_DIR },
  })
  sessionId = session.id
  // Printed first so a caller can capture it even if the turn later fails.
  console.log(JSON.stringify({ session_id: session.id }))
}

// Open the stream before sending input. The controller reacts to
// `action_required`, and this is how the wait becomes observable rather than a
// silent five minutes.
const events = await client.beta.agents.sessions.events.stream(sessionId)

await client.beta.agents.sessions.events.create(sessionId, {
  events: [
    {
      type: 'agent.session.input.message',
      input: [{ role: 'user', content: [{ type: 'input_text', text: input }] }],
    },
  ],
})

for await (const event of events) {
  switch (event.type) {
    case 'agent.session.environment.pending':
    case 'agent.session.environment.connected':
    case 'agent.session.environment.disconnected':
      console.error(`[${event.type}]`)
      break

    case 'agent.session.environment.failed':
      console.error(`[${event.type}] ${JSON.stringify(event)}`)
      console.error(
        'Check the controller log, then the executor log in the worker sandbox.'
      )
      process.exit(1)

    case 'agent.session.turn.output_text.delta':
      process.stdout.write(event.delta)
      break

    case 'agent.session.turn.completed':
      process.stdout.write('\n')
      process.exit(0)

    case 'agent.session.turn.failed':
    case 'agent.session.failed':
      console.error(`\n[${event.type}] ${JSON.stringify(event)}`)
      process.exit(1)
  }
}
