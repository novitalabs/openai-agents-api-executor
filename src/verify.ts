/**
 * Verifies the built template without touching the Agents API.
 *
 * Needs only NOVITA_API_KEY, so it can run before OpenAI credentials exist.
 * It checks the things that would otherwise fail much later as an opaque
 * "environment pending" during a real session.
 *
 *   npm run verify
 */
import { Sandbox } from 'novita-sandbox'
import type { CommandResult } from 'novita-sandbox'
import {
  CODEX_HOME,
  CODEX_VERSION,
  TEMPLATE_NAME,
  WORKSPACE_DIR,
  requireEnv,
} from './config.js'

requireEnv('NOVITA_API_KEY')

interface Check {
  name: string
  command: string
  envs?: Record<string, string>
  expect?: (stdout: string) => boolean
}

const checks: Check[] = [
  {
    name: 'codex binary on PATH',
    command: 'command -v codex',
  },
  {
    name: `codex version is pinned to ${CODEX_VERSION}`,
    command: 'codex --version',
    expect: (out) => out.includes(CODEX_VERSION),
  },
  {
    name: 'exec-server subcommand exists',
    command: 'codex exec-server --help',
    expect: (out) => out.includes('--environment-id'),
  },
  {
    name: `${WORKSPACE_DIR} is writable by the sandbox user`,
    command: `test -w ${WORKSPACE_DIR} && touch ${WORKSPACE_DIR}/.probe && rm ${WORKSPACE_DIR}/.probe && echo writable`,
    expect: (out) => out.includes('writable'),
  },
  {
    name: `${CODEX_HOME} is writable by the sandbox user`,
    command: `test -w ${CODEX_HOME} && echo writable`,
    expect: (out) => out.includes('writable'),
  },
  {
    // A build-layer ENV does not reach processes started through the commands
    // API. Asserting that here keeps the fact measured rather than assumed: if
    // the platform ever starts propagating it, this check fails and the runner
    // can stop passing it explicitly.
    name: 'build-layer CODEX_HOME is absent at runtime (must be passed per command)',
    command: 'printenv CODEX_HOME || echo ABSENT',
    expect: (out) => out.trim() === 'ABSENT',
  },
  {
    name: 'CODEX_HOME works when passed with the command',
    command: 'printenv CODEX_HOME',
    envs: { CODEX_HOME },
    expect: (out) => out.trim() === CODEX_HOME,
  },
  {
    name: 'runs as an unprivileged user that owns the workspace',
    command: 'whoami && test -O ' + WORKSPACE_DIR + ' && echo owned',
    expect: (out) => out.includes('owned') && !out.includes('root'),
  },
  {
    name: 'agent tooling present (git, python3, rg)',
    command: 'command -v git && command -v python3 && command -v rg',
  },
  {
    name: 'workdir is the workspace',
    command: 'pwd',
    expect: (out) => out.trim() === WORKSPACE_DIR,
  },
]

const started = Date.now()
console.log(`Creating sandbox from ${TEMPLATE_NAME}`)
const sandbox = await Sandbox.create(TEMPLATE_NAME, { timeoutMs: 5 * 60 * 1000 })
console.log(`  ready in ${Date.now() - started}ms (sandbox ${sandbox.sandboxId})`)

let failed = 0
try {
  for (const check of checks) {
    // Exit code alone is not enough: a wrong-but-present binary passes it,
    // so most checks also assert on stdout.
    const result = await sandbox.commands
      .run(check.command, {
        timeoutMs: 60_000,
        requestTimeoutMs: 60_000,
        ...(check.envs ? { envs: check.envs } : {}),
      })
      // A nonzero exit throws CommandExitError. Catch it so one failure does
      // not hide the remaining checks, and keep its real fields rather than
      // flattening everything to exit=1 with the message as stderr.
      .catch((error: unknown) => {
        const partial = error as Partial<CommandResult>
        return {
          exitCode: partial?.exitCode ?? 1,
          stdout: partial?.stdout ?? '',
          stderr: partial?.stderr ?? String(error),
        }
      })

    const ok =
      result.exitCode === 0 &&
      (check.expect ? check.expect(result.stdout) : true)

    console.log(`${ok ? 'PASS' : 'FAIL'}  ${check.name}`)
    if (!ok) {
      failed += 1
      console.log(`      exit=${result.exitCode}`)
      if (result.stdout) console.log(`      stdout: ${result.stdout.trim().slice(0, 400)}`)
      if (result.stderr) console.log(`      stderr: ${result.stderr.trim().slice(0, 400)}`)
    }
  }
} finally {
  await sandbox.kill()
}

console.log(
  failed === 0
    ? `\nAll ${checks.length} checks passed.`
    : `\n${failed} of ${checks.length} checks failed.`
)
process.exit(failed === 0 ? 0 : 1)
