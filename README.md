# Novita Sandbox

Run sandbox tools in Novita while OpenAI runs the agent and maintains session
state. OpenAI hosts the [Codex harness](https://developers.openai.com/api/docs/guides/agents-api/overview);
the sandbox runs `codex exec-server`, which dials out to OpenAI to receive
commands and return results. Nothing listens on an inbound port.

```
application ──create session──▶ Agents API ◀──outbound ws── codex exec-server
     │                                                        (Novita sandbox)
     └──start sandbox + executor───────────────────────────────────┘
```

Choose a provisioning mode:

- **[Application-managed](#application-managed):** your application creates the
  sandbox and connects its executor directly.
- **[Webhook-managed](#webhook-managed):** a controller starts or reconnects
  sandboxes from OpenAI webhooks, so your application never touches the sandbox
  SDK.

Both are implemented here. [Sandbox lifecycle](https://developers.openai.com/api/docs/guides/agents-api/environments/lifecycle)
compares them.

Attaching an agent to a sandbox you already own is the common case in either
mode; `npm run example` is that path as running code.

## Before you begin

```bash
cp .env.example .env
npm install
```

| Variable | Where it comes from | Scope |
| --- | --- | --- |
| `NOVITA_API_KEY` | Novita console | template build, sandbox lifecycle |
| `OPENAI_API_KEY` | [platform.openai.com/api-keys](https://platform.openai.com/api-keys) | your application; **never** enters the sandbox |
| `OPENAI_EXECUTOR_API_KEY` | [platform Agents tab → environment keys](https://platform.openai.com/agents?tab=environments&environment_view=keys) | the only credential that enters the sandbox |

The application key needs `api.agents.read`, `api.agents.write`, and
`api.responses.write`. The executor key needs **every other permission set to
None** — it can connect environments and nothing else, which is what makes it safe
for agent-generated code to read. Both keys must belong to the same organization,
project, and user or service account, or the session and its executor will not
match up.

See [executor authentication](https://developers.openai.com/api/docs/guides/agents-api/environments/self-hosted#authentication)
for OpenAI's own description of the split.

## Application-managed

Your application owns the sandbox for the whole session: create it, start the
executor, send input, then release both when finished. Two steps to a working
session — the first needs only `NOVITA_API_KEY`.

### 1. Create a sandbox

The executor template is published, so there is nothing to build:

```bash
npm install -g novita-sandbox-cli
export NOVITA_API_KEY=...

novita sbx create openai-agents-api-executor --long-running --timeout 720h
```

Keep the sandbox id it prints — the agent attaches to this sandbox, and its
files outlive any single turn.

### 2. Run one real session

```bash
npm run e2e
```

It creates a self-hosted session, starts a sandbox and the executor, waits for the
environment to connect, asks the agent to write a file, and then checks the
**sandbox filesystem** for that file rather than trusting the agent's summary. It
deletes the session and kills the sandbox on the way out, including on failure.

A pass looks like this:

```
1. Creating self-hosted session
   session=sess_... environment=env_...
2. Starting sandbox and executor
   sandbox=i...
3. Waiting for the environment to connect
   agent.session.environment.pending
   agent.session.environment.connected
4. Sending a task
5. Checking the workspace for the written file
   file contents: novita executor ok

Timing breakdown:
   ...ms  session created
   ...ms  executor started
   ...ms  environment connected
   ...ms  input accepted
   ...ms  file observed

PASS
```

The timing breakdown is the point of the exercise: the API allows five minutes
for an input-time connection, and this shows which phase actually consumes it.

### If it fails

The failing step number tells you where to look.

| Fails at | Likely cause |
| --- | --- |
| 1, `401`/`403` | Application key missing `api.agents.*` or `api.responses.write`. |
| 1, `400 invalid_beta` | The `OpenAI-Beta: agents=v1` header is missing. `openai@7.15.0` sends it; an older SDK does not. |
| 2 | Template missing or not built — run `npm run verify` first. |
| 3, stuck then timing out | Executor never registered. Read `/tmp/codex-executor.log` in the sandbox. Usually the executor key is wrong, or belongs to a different project than the application key. |
| 3, `environment.failed` | Same log. Registration failures appear there, not in any HTTP status. |
| 5, file never appears | The environment connected but commands are failing. Read the executor log; this is the case that would expose an `exec-server` filesystem-sandbox problem inside a microVM. |

The sandbox is killed on failure, so to inspect one, re-run with the teardown
commented out or reproduce the step by hand against a sandbox you keep alive.

### What each step does

The three commands above wrap the sequence below. Read it when adapting the flow
to your own application rather than running the examples.

#### Build the executor template

The published template bakes in `codex exec-server` at a pinned version, so an
executor boots with the CLI already present and every sandbox runs the same
image. Rebuild only to change what is in it — a newer Codex, extra tooling:

```bash
npm run build:template   # optional; about 1m15s cold, 30s warm
```

Two details matter if you do build your own:

- **Pin the Codex version.** `@openai/codex@alpha` floats. Two templates built a
  week apart would ship different executors and diverge with no visible cause.
- **Do not set a start command.** A template start command runs once at build
  time and is snapshotted, so it cannot see the environment id, which only exists
  once a session is created. Start the executor at runtime instead.

Verify the image before using it in a session. This needs only `NOVITA_API_KEY`:

```bash
npm run verify
```

#### Create a self-hosted session

```ts
import OpenAI from 'openai'

const client = new OpenAI()
const session = await client.beta.agents.sessions.create({
  agent: { model: 'gpt-6-astra', instructions: 'You are a coding assistant.' },
  environment: { type: 'self_hosted', workspace_directory: '/workspace' },
})
```

Save `session.id` with your conversation state. `session.environment` is a union
across the hosted and self-hosted variants, so narrow it before use:

```ts
const environment = session.environment
if (environment?.type !== 'self_hosted') throw new Error('not self-hosted')
```

Pass `environment.remote_url` to the executor unchanged, including on reconnect.

#### Start the sandbox and executor

```ts
const executor = await startExecutor({
  environmentId: environment.id,
  remoteUrl: environment.remote_url,
  executorApiKey: process.env.OPENAI_EXECUTOR_API_KEY!,
  sessionId: session.id,
})
```

The executor dials out to OpenAI; nothing listens on an inbound port. One
executor serves one session, so there is no way to keep a pool of pre-connected
executors warm.

#### Send input and follow the result

Follow `client.beta.agents.sessions.events.stream(session.id)` for connection
state: `agent.session.environment.connected` means the executor attached, and
`agent.session.environment.failed` is the only place a registration failure is
reported — a session retrieve would keep returning `pending` until the window
expired, which looks identical to a network problem.

The agent needs both a connected environment and user input before it starts.
Verify outcomes against the sandbox filesystem rather than the agent's own
narration: a turn can report success while the write never landed.

```bash
npm run e2e                            # throwaway sandbox, checks the plumbing
npm run example                        # own the sandbox, attach an agent, keep it
npm run example -- --sandbox-id <id>   # reuse that sandbox for another turn
```

`e2e` verifies the setup; `example` is the shape to copy for a real integration.

#### Clean up

Delete the session and stop the sandbox separately. Deleting a session neither
stops its environment nor emits a webhook.

## Webhook-managed

A controller in its own sandbox receives OpenAI webhooks and provisions one
worker sandbox per session. Your application only creates sessions and sends
input; it never imports the sandbox SDK.

The API emits `agent.session.action_required` with
`required_action.type: "environment_connection"` before it waits for the
executor, and waits up to five minutes. The controller verifies the signature,
queues the session, re-reads it, and then creates a worker — or resumes a paused
one found by its `agents-session-id` metadata, since pausing preserves the
files and a replacement worker starts empty.

```bash
npm run webhook:client -- --create-agent <name>   # agent id goes in .env
npm run webhook:deploy                            # prints the webhook URL
```

`--create-agent` takes `--instructions` and `--model` to give the agent its own
role. Both are ordinary [agent configuration](https://developers.openai.com/api/docs/guides/agents-api/configuration)
fields; the flags only stop this client from hardcoding them. `--update-agent <id>`
edits them in place, which keeps the agent id and so needs no redeploy.

```bash
npm run webhook:client -- --create-agent triage \
  --instructions "You triage failing tests: find the failing assertion, propose the smallest fix." \
  --model gpt-5.6-luna
npm run webhook:client -- --update-agent "$OPENAI_AGENT_ID" --instructions "..."
```

Register that URL in the OpenAI platform under **Project settings → Webhooks**
for `agent.session.action_required` and `agent.session.failed`, put the signing
secret in `OPENAI_WEBHOOK_SECRET`, and deploy once more so the controller reads
it:

```bash
npm run webhook:deploy
curl -sX POST <webhook-url> -d '{}'
#   {"error":"Invalid signature"}      -> the secret is loaded
#   {"error":"Webhook not configured"} -> it is not
```

Then send work. The first line of output is the session id; pass it back to
continue in the same workspace:

```bash
npm run webhook:client -- --input "Write hello to /workspace/hello.txt, then read it back."
npm run webhook:client -- --session-id "$SESSION_ID" --input "Read it again."
```

Releasing a session does not release its sandbox — there is no session-deletion
webhook:

```bash
npm run webhook:client -- --session-id "$SESSION_ID" --delete
novita sbx kill <worker-id>
```

Register the webhook in the project that owns `OPENAI_API_KEY`. One registered
in another project of the same organization is never delivered, and the first
input then fails only after the full five-minute wait.

Redeploy whenever `OPENAI_AGENT_ID`, `OPENAI_WEBHOOK_SECRET`, or any key
changes: the controller filters by agent id, so a stale one makes it ignore
every new session silently. Changing `AGENTS_MODEL` needs no redeploy — the
model belongs to the saved agent, not the controller.

The controller is created with `long_running: 'true'` metadata and
`lifecycle: pause + autoResume`, because its sandbox id is part of the URL you
just registered: if it were killed on timeout, redeploying would produce a new
id and you would have to register the webhook again by hand.

Full setup, logs, and cleanup: [src/webhook/README.md](src/webhook/README.md).

## Connection window

The API waits up to five minutes for an input-time connection. If it expires the
submission fails and is not replayed, so do not resubmit while an earlier request
is still waiting. Baking the Codex CLI into the template keeps the install out of
this window; a sandbox boots from the template in about two seconds.

## Environment variables reach the executor per command

A build-layer `ENV` is **not** visible to processes started later through the
commands API, not even in a login shell. `CODEX_HOME` therefore travels with the
executor in `commands.run({ envs })`, which `npm run verify` asserts in both
directions.

## Troubleshooting

| Symptom | Check |
| --- | --- |
| Session stays in `environment.pending` | Executor process alive? If you restrict egress, allowlist `api.openai.com` and `codex-cloud-environments.chatgpt.com`. Novita allows outbound traffic by default, so no configuration is needed otherwise. |
| Executor dies around 61 seconds | `commands.run` started without `background: true`. |
| Every SDK call fails with 503 and an HTML body | `NOVITA_DOMAIN` set to a region the SDK does not recognize. Leave it unset. |
| `environment.failed` | Read the executor logs. Registration failures surface there, not in the HTTP status. |
| `CODEX_HOME` empty inside the sandbox | Expected for a build-layer ENV. Pass it with the command. |
| Agent reports success but files are missing | Assert against the sandbox filesystem, not the final response. |
| `novita-sandbox-cli sandbox exec` hangs with no output | Non-interactive stdin is treated as piped input and waited on. Add `</dev/null` to every `exec` in a script. |

## Layout

| Path | Purpose |
| --- | --- |
| `src/config.ts` | Pinned Codex version, paths, timeouts |
| `src/build-template.ts` | Builds the template with `codex exec-server` baked in |
| `src/verify.ts` | Ten checks against the built image; needs only `NOVITA_API_KEY` |
| `src/runner.ts` | Starts a sandbox and binds one executor to one session |
| `src/example.ts` | The normal case as running code: own the sandbox, attach an agent, keep the sandbox |
| `src/e2e.ts` | Throwaway sandbox per session, to check the plumbing; prints a timing breakdown |
| `src/webhook/` | Webhook-managed variant: controller, deploy, client ([README](src/webhook/README.md)) |

## References

- [Self-hosted sandboxes](https://developers.openai.com/api/docs/guides/agents-api/environments/self-hosted)
- [Sandbox lifecycle](https://developers.openai.com/api/docs/guides/agents-api/environments/lifecycle)
- [Novita Sandbox documentation](https://novita.ai/docs)
