/**
 * Puts the controller into its own Novita sandbox and starts it.
 *
 * Rerunning reconnects to the existing controller and restarts it with fresh
 * environment variables, which is how the webhook secret gets installed after
 * the webhook is registered. If that sandbox is gone, a new one is created and
 * the URL changes — the OpenAI webhook then has to be updated too.
 *
 *   npm run webhook:deploy
 */
import { readFileSync } from 'node:fs'
import { Sandbox } from 'novita-sandbox'
import { requireEnv } from '../config.js'
import {
  CONTROLLER_LOG,
  CONTROLLER_STDIO,
  LONG_RUNNING_METADATA,
  SANDBOX_LIFECYCLE,
  CONTROLLER_METADATA,
  CONTROLLER_PORT,
  CONTROLLER_TIMEOUT_MS,
  TEMPLATE_NAME,
  WEBHOOK_EVENTS,
} from './config.js'

requireEnv('NOVITA_API_KEY')
const openaiApiKey = requireEnv('OPENAI_API_KEY')
const executorApiKey = requireEnv('OPENAI_EXECUTOR_API_KEY')
// Empty on the first deploy: the secret only exists once the webhook is
// registered, and registering needs the URL this script prints.
const webhookSecret = process.env.OPENAI_WEBHOOK_SECRET || ''
const agentId = process.env.OPENAI_AGENT_ID || ''

const CONTROLLER_DIR = '/app'
const BUNDLE = `${CONTROLLER_DIR}/controller.mjs`

/**
 * Bundle the controller to a single file.
 *
 * Bundling avoids installing dependencies inside the controller sandbox on
 * every deploy, which would otherwise be the slowest part of a redeploy.
 */
async function bundleController(): Promise<string> {
  const { build } = await import('esbuild')
  const result = await build({
    entryPoints: ['src/webhook/handler.ts'],
    bundle: true,
    platform: 'node',
    target: 'node22',
    format: 'esm',
    // Node builtins that esbuild's esm output otherwise mangles.
    banner: {
      js: "import{createRequire}from'node:module';const require=createRequire(import.meta.url);",
    },
    write: false,
    logLevel: 'warning',
  })
  const output = result.outputFiles?.[0]
  if (!output) throw new Error('esbuild produced no output')
  return output.text
}

async function findController(): Promise<string | undefined> {
  // Prefer the id recorded by the last deploy, so a controller that is merely
  // paused is reused rather than replaced.
  const recorded = readRecordedId()
  if (recorded) {
    const alive = await Sandbox.connect(recorded)
      .then(() => recorded)
      .catch(() => undefined)
    if (alive) return alive
  }

  const items = await Sandbox.list({
    query: { metadata: { ...CONTROLLER_METADATA } },
  }).nextItems()
  return items.at(0)?.sandboxId
}

function readRecordedId(): string | undefined {
  try {
    return JSON.parse(readFileSync('.controller.json', 'utf8')).sandboxId
  } catch {
    return undefined
  }
}

const source = await bundleController()

let sandbox: Sandbox
const existing = await findController()
if (existing) {
  sandbox = await Sandbox.connect(existing)
  await sandbox.setTimeout(CONTROLLER_TIMEOUT_MS)
  console.log(`Reusing controller sandbox ${sandbox.sandboxId}`)
  // Restart so the new environment variables take effect. pkill matches the
  // bundle path rather than "node", which would also match this deploy's own
  // helper processes inside the sandbox.
  await sandbox.commands
    .run(`pkill -f ${BUNDLE} || true`, { timeoutMs: 30_000 })
    .catch(() => {})
} else {
  sandbox = await Sandbox.create(TEMPLATE_NAME, {
    timeoutMs: CONTROLLER_TIMEOUT_MS,
    // Pause rather than kill: the sandbox id is baked into the webhook URL
    // registered with OpenAI, and a killed controller can only be replaced by a
    // new sandbox with a different id, which means re-registering the webhook.
    // Pausing keeps the id, and autoResume brings it back on the next delivery.
    lifecycle: SANDBOX_LIFECYCLE,
    metadata: { ...CONTROLLER_METADATA, ...LONG_RUNNING_METADATA },
  })
  console.log(`Created controller sandbox ${sandbox.sandboxId}`)
}

await sandbox.files.makeDir(CONTROLLER_DIR).catch(() => {})
await sandbox.files.write(BUNDLE, source)

// Background start, so the deploy does not sit inside the 60s command timeout
// that would otherwise kill the controller at 61 seconds.
// Redirect stdout/stderr into the sandbox. Without this the controller's own
// output goes to the command channel and is lost when deploy exits, so a crash
// leaves no evidence: controller.log only holds what the handler chose to log,
// which stops before any stack trace. setsid detaches it from the channel's
// process group as well, so a channel teardown cannot signal it.
await sandbox.commands.run(
  `setsid node ${BUNDLE} >> ${CONTROLLER_STDIO} 2>&1 < /dev/null`,
  {
    background: true,
    envs: {
      OPENAI_API_KEY: openaiApiKey,
      OPENAI_EXECUTOR_API_KEY: executorApiKey,
      OPENAI_WEBHOOK_SECRET: webhookSecret,
      OPENAI_AGENT_ID: agentId,
      NOVITA_API_KEY: requireEnv('NOVITA_API_KEY'),
    },
  }
)

const host = sandbox.getHost(CONTROLLER_PORT)
const webhookUrl = `https://${host}/webhook`

await sandbox.files.write(
  `${CONTROLLER_DIR}/.deployed`,
  new Date().toISOString()
)
const { writeFileSync } = await import('node:fs')
writeFileSync(
  '.controller.json',
  JSON.stringify({ sandboxId: sandbox.sandboxId, webhookUrl }, null, 2) + '\n'
)

console.log(`\nWebhook: ${webhookUrl}`)
console.log(`Controller log: ${CONTROLLER_LOG} (inside ${sandbox.sandboxId})`)

if (!webhookSecret) {
  console.log(
    `\nNext: register that URL in the OpenAI platform under the project that owns\n` +
      `OPENAI_API_KEY, for these events:\n` +
      WEBHOOK_EVENTS.map((event) => `  - ${event}`).join('\n') +
      `\nThen put the signing secret in OPENAI_WEBHOOK_SECRET and redeploy.\n` +
      `\nUntil then the controller answers 503 "Webhook not configured".`
  )
} else {
  console.log(
    `\nSignature verification is enabled. Sanity check:\n` +
      `  curl -sX POST ${webhookUrl} -d '{}'\n` +
      `expects {"error":"Invalid signature"}.`
  )
}
