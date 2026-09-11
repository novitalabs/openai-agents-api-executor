# Webhook-managed provisioning

OpenAI runs the agent and keeps session state. A **controller** in its own Novita
sandbox receives OpenAI webhooks and starts, resumes, or pauses a separate
**worker** sandbox per session. Agent commands run only in the worker. The
application never imports the sandbox SDK.

For the application-managed alternative, where your own process provisions the
sandbox, see the [repository README](../../README.md).

```
client.ts      create agent / session, send input, stream the turn   (your app)
deploy.ts      bundle handler.ts into a Novita sandbox and run it    (one-off)
handler.ts     webhook receiver + per-session queue                  (controller)
```

## How a turn flows

1. `client.ts` creates a `self_hosted` session and posts input.
2. OpenAI emits `agent.session.action_required` with
   `required_action.type: "environment_connection"` **before** waiting for the
   executor. That wait is up to five minutes.
3. The controller verifies the signature, queues the session id, returns 200,
   then reconciles: it re-reads the session and, only if the action is still
   pending, creates a worker from the template (or resumes a paused one, found by
   `agents-session-id` metadata) and launches `codex exec-server` inside it.
4. The executor connects, the turn runs, the client streams output.
5. `agent.session.failed` **pauses** that session's worker rather than killing
   it, so the executor log can be read afterwards. Kill it yourself when done.

Turn creation and `agent.session.in_progress` both arrive too late to start an
offline executor, which is why `action_required` is the event that matters.

## Setup

| Variable | Used by |
| --- | --- |
| `OPENAI_API_KEY` | client (creates sessions) and controller (reads session state) |
| `OPENAI_EXECUTOR_API_KEY` | the only credential that enters a worker, as `CODEX_API_KEY` |
| `OPENAI_AGENT_ID` | client and controller; the controller ignores other agents' sessions |
| `NOVITA_API_KEY` | deploy (controller sandbox) and controller (worker sandboxes) |
| `OPENAI_WEBHOOK_SECRET` | controller; set after registering the webhook |

1. Nothing to build — workers and the controller both come from the published
   `openai-agents-api-executor` template. To confirm it first:

   ```bash
   npm run verify
   ```

2. Create an agent and put its id in `.env`:

   ```bash
   npm run webhook:client -- --create-agent novita-webhook-managed
   ```

3. Deploy the controller, leaving `OPENAI_WEBHOOK_SECRET` empty for now:

   ```bash
   npm run webhook:deploy
   # Webhook: https://8000-<sandbox-id>.<domain>/webhook
   ```

   The sandbox id is saved to the ignored `.controller.json`. Rerunning
   `webhook:deploy` reconnects to the same controller and restarts it with fresh
   environment variables. If that sandbox is gone, a new one is created and the
   URL changes, so the OpenAI webhook has to be updated too.

4. Register that URL in the OpenAI platform under **Project settings → Webhooks**
   for `agent.session.action_required` and `agent.session.failed`.

   **Pick the project that owns `OPENAI_API_KEY`.** A webhook registered in
   another project of the same organization is never delivered, and the first
   input then fails only after the full five-minute wait.

5. Put the signing secret in `OPENAI_WEBHOOK_SECRET` and redeploy.

   Sanity check: `curl -sX POST <webhook-url> -d '{}'` returns
   `{"error":"Invalid signature"}` (400). Before the secret is installed it
   returns `{"error":"Webhook not configured"}` (503).

## Run

```bash
npm run webhook:client -- --agent-id "$OPENAI_AGENT_ID" \
  --input "Write hello to /workspace/hello.txt with the shell, then read it back."
```

The first line printed is `{"session_id":"sess_..."}`. Keep it for follow-ups:

```bash
npm run webhook:client -- --session-id "$SESSION_ID" --input "Read it again."
```

Workers stay running between turns. A paused worker is resumed with files intact;
a killed one is replaced by a fresh worker with no previous files, because reusing
the environment id does not restore them.

## Inspect

- Controller log: `/app/controller.log` inside the controller sandbox, JSON lines
  (`enqueued`, `worker_created`, `worker_resumed`, `executor_started`,
  `action_resolved`, `reconcile_failed`).
- Executor log: `/tmp/codex-executor.log` inside each worker. Registration
  failures surface here, not in any HTTP status.
- Workers carry metadata `agents-session-id=<session>`; the controller carries
  `agents-webhook-controller=novita`.

## Lifetimes

| Sandbox | Setting | Why |
| --- | --- | --- |
| Controller | `long_running: 'true'`, `timeoutMs` at the platform ceiling, `onTimeout: pause` + `autoResume` | Its sandbox id is in the registered webhook URL. A replacement has a different id and needs re-registering by hand. |
| Worker | 30 minutes, `onTimeout: pause` + `autoResume` | Pausing preserves the workspace; a replacement worker starts empty, because reusing the environment id does not restore files. |

`long_running` and `lifecycle` both have to be passed at creation, so changing
either means replacing the sandbox.

Redeploy after changing `OPENAI_AGENT_ID`, `OPENAI_WEBHOOK_SECRET`, or any key —
the controller reads them at startup. A stale `OPENAI_AGENT_ID` is the quiet
failure: the controller filters by agent, so every new session is ignored with no
error anywhere. Changing `AGENTS_MODEL` needs no redeploy, since the model
belongs to the saved agent. For the same reason, editing an agent's instructions
or model with `--update-agent` needs no redeploy either: the id does not change,
so the controller keeps matching.

## Cleanup

There is no session-deletion webhook, so release both sides:

```bash
npm run webhook:client -- --session-id "$SESSION_ID" --delete
# then kill the worker sandbox, including if paused
```

Workers have a 30-minute timeout, refreshed on resume. The controller has a
one-hour timeout, extended by every deploy. Remove the OpenAI webhook before
retiring the controller for good.

## Design notes

**Verify and queue, then reconcile.** The request path only verifies the
signature and queues; 200 is returned before any sandbox work starts, so OpenAI
never waits on provisioning. The queue worker then re-reads the session, which is
what makes a duplicate or late delivery harmless — if the action already
resolved, starting a worker would leak compute nothing is waiting for.

**One queue slot per session.** Deliveries for the same session are serialised so
two of them cannot both create a worker; different sessions still reconcile
concurrently.

**A failed session's worker is paused, not killed.** Pausing keeps the filesystem
so the executor log survives for inspection.

**The controller is bundled, not installed.** `deploy.ts` bundles `handler.ts`
with esbuild and writes one file, so a redeploy does not reinstall dependencies
inside the sandbox. The bundle needs a `createRequire` banner: `dotenv` reaches it
transitively as CommonJS and esbuild's ESM output otherwise fails at startup with
`Dynamic require of "fs" is not supported`.
