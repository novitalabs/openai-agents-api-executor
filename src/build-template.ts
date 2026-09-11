/**
 * Builds the Novita Sandbox template used as a self-hosted execution
 * environment for the OpenAI Agents API.
 *
 * The image bakes in `codex exec-server` at a pinned version. It deliberately
 * sets NO start command: the executor must be launched per session with that
 * session's `environment_id`, and a template start command runs once at build
 * time and is then snapshotted — it cannot see a value that only exists when
 * the session is created. The runner starts the executor over the commands API
 * instead (see src/runner.ts).
 *
 *   npm run build:template
 */
import { Template, TemplateBase, defaultBuildLogger } from 'novita-sandbox'
import {
  CODEX_HOME,
  CODEX_VERSION,
  TEMPLATE_NAME,
  WORKSPACE_DIR,
  optionalEnv,
  requireEnv,
} from './config.js'

requireEnv('NOVITA_API_KEY')

const tag = optionalEnv('NOVITA_BUILD_TAG')
const target = tag ? `${TEMPLATE_NAME}:${tag}` : TEMPLATE_NAME

const template = Template()
  .fromNodeImage('22')
  // What the agent needs to do real work in the workspace: git, a Python
  // runtime, ripgrep (codex's search backend), and file/PDF inspection.
  .aptInstall([
    'ca-certificates',
    'curl',
    'file',
    'git',
    'poppler-utils',
    'python3',
    'python3-pip',
    'ripgrep',
  ])
  .runCmd(
    [
      `npm install --global @openai/codex@${CODEX_VERSION}`,
      `mkdir -p ${WORKSPACE_DIR} ${CODEX_HOME}`,
      `chown -R user:user ${WORKSPACE_DIR} ${CODEX_HOME}`,
    ],
    { user: 'root' }
  )
  // Build-time self-check. Without it a broken or renamed binary surfaces much
  // later as a session stuck in `environment.pending`, which looks identical to
  // a network-policy problem.
  .runCmd('codex exec-server --help >/dev/null')
  // No setEnvs for CODEX_HOME: a build-layer ENV is not visible to processes
  // started later through the commands API, not even in a login shell
  // (measured). The runner passes CODEX_HOME with the executor instead, which is
  // the only way it reliably arrives.
  .setWorkdir(WORKSPACE_DIR)

console.log(`Building ${target} with codex ${CODEX_VERSION}`)

const build = await TemplateBase.build(template, target, {
  cpuCount: 2,
  memoryMB: 4096,
  onBuildLogs: defaultBuildLogger(),
})

console.log(
  `Built template=${build.templateId} build=${build.buildId} alias=${target}`
)
