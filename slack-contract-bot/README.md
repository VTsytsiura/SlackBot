# slack-contract-bot

A Slack bot (Bolt SDK, Socket Mode) that relays conversation to a Salesforce
Agentforce agent and returns its replies — including generated contract
files — back into Slack.

## Architecture

```
Slack (message) → Bot (Socket Mode) → Agentforce Agent API → Apex Actions → Salesforce
                                    ← agent reply / generated file ←
```

- `src/app.ts` — Slack Bolt app, message handler, per-channel agent session
  state, and file-attachment handling.
- `src/agentforce.ts` — Salesforce Agentforce Agent API client (auth,
  session lifecycle, sending messages).
- `src/salesforce.ts` — Salesforce REST API client for downloading generated
  files via ContentVersion.
- `src/slackFormatting.ts` — converts `[[SLACK_BTN|label|url]]` placeholders
  from the agent's reply into Slack Block Kit buttons.
- `src/openai.ts` — optional: generates a context-aware "working on it..."
  placeholder message while the agent call is in flight.
- `src/health.ts` — minimal HTTP server exposing `GET /health` (and `GET /`)
  so hosting platforms can healthcheck the process. The bot itself only
  communicates with Slack over Socket Mode; this server does not carry any
  bot traffic.
- `src/logger.ts` — tiny leveled logger; writes one JSON object per line
  (CloudWatch-friendly). Controlled by `LOG_LEVEL`.
- `deploy/ecs-task-definition.json` — ECS Fargate task definition template.

## Local development

```bash
npm install
npm run dev
```

`npm run dev` runs `src/app.ts` directly via `ts-node`. Requires a `.env`
file (see below).

## Production build

```bash
npm run build   # compiles src/ -> dist/ via tsc
npm start        # runs the compiled dist/app.js (no ts-node/TypeScript at runtime)
```

## Environment variables

Copy `.env.example` to `.env` and fill in real values locally. In production
inject the same keys through your platform (AWS: see below).

The bot exits at startup with a clear error if any of `SLACK_BOT_TOKEN`,
`SLACK_APP_TOKEN`, `SF_AGENT_CLIENT_ID`, `SF_AGENT_CLIENT_SECRET` or
`SF_AGENT_ID` is missing.

- `SLACK_BOT_TOKEN`, `SLACK_APP_TOKEN` — required.
- `SLACK_SIGNING_SECRET` — not used in Socket Mode.
- `SF_AGENT_CLIENT_ID`, `SF_AGENT_CLIENT_SECRET`, `SF_AGENT_ID` — required.
- `SF_AGENT_LOGIN_URL` — your Salesforce My Domain URL (Client Credentials
  Flow token endpoint).
- `OPENAI_API_KEY` — optional; enables the smarter "working on it..." placeholder.
- `OPENAI_MODEL` — optional; defaults to `gpt-4o-mini`.
- `LOG_LEVEL` — optional; `debug` | `info` (default) | `warn` | `error`.
  `debug` also logs raw Agent API responses, which may contain contract data —
  enable it only temporarily.
- `PORT` — optional; health check server port (default `3000`).

## Logging

Logs are single-line JSON (`time`, `level`, `msg`, plus context fields such as
`channelId` / `sessionId`; errors are under `err` with a stack trace). User
messages and agent replies are not logged at `info` and above. Example
CloudWatch Logs Insights query for errors:

```
fields @timestamp, msg, err.message, channelId
| filter level = "error"
| sort @timestamp desc
```

Slack Bolt's own library logs (connection state) use its plain-text format.

## Deployment (AWS ECS Fargate)

The image is a multi-stage build (`Dockerfile`): the **build** stage compiles
TypeScript to `dist/`; the **runtime** stage installs production dependencies
only and runs `node dist/app.js` as the unprivileged `node` user.

The bot connects out to Slack (Socket Mode), so it needs **no load balancer,
no inbound security-group rules, and no port mappings** — only outbound HTTPS
(public IP, or private subnet + NAT). The container health check in the task
definition hits `/health` from inside the container.

> **Run exactly one task (`desired-count 1`).** Conversation state lives in
> memory and Socket Mode spreads events across all connected instances, so a
> second task would split conversations. During a rolling deploy two tasks
> briefly overlap; a conversation that lands on the new task just starts a
> fresh agent session.

### One-time setup

Replace region/names as needed.

```bash
export AWS_REGION=eu-central-1
export ACCOUNT_ID=$(aws sts get-caller-identity --query Account --output text)
export ECR=$ACCOUNT_ID.dkr.ecr.$AWS_REGION.amazonaws.com

aws ecr create-repository --repository-name slack-contract-bot

aws logs create-log-group --log-group-name /ecs/slack-contract-bot
aws logs put-retention-policy --log-group-name /ecs/slack-contract-bot --retention-in-days 30

aws ecs create-cluster --cluster-name slack-contract-bot
```

**Secrets.** In Secrets Manager → *Store a new secret* → *Other type of secret*,
create one secret named `slack-contract-bot/prod` with these key/value pairs:
`SLACK_BOT_TOKEN`, `SLACK_APP_TOKEN`, `SF_AGENT_CLIENT_ID`,
`SF_AGENT_CLIENT_SECRET`, `SF_AGENT_ID`, `OPENAI_API_KEY`. Every key listed
under `secrets` in the task definition must exist in the secret, or the task
fails to start — if you don't use OpenAI, remove that entry from the JSON.

**IAM.** The task execution role (`ecsTaskExecutionRole`) needs the AWS-managed
`AmazonECSTaskExecutionRolePolicy` plus permission to read the secret:

```json
{
  "Effect": "Allow",
  "Action": "secretsmanager:GetSecretValue",
  "Resource": "<SECRET_ARN>"
}
```

**Task definition.** Fill in every `<PLACEHOLDER>` in
`deploy/ecs-task-definition.json` (`<ACCOUNT_ID>`, `<REGION>`, `<SECRET_ARN>`
including its random suffix, `<MY_DOMAIN>`), then:

```bash
aws ecs register-task-definition --cli-input-json file://deploy/ecs-task-definition.json
```

**Service** (subnets and security group must allow outbound 443):

```bash
aws ecs create-service \
  --cluster slack-contract-bot --service-name slack-contract-bot \
  --task-definition slack-contract-bot --desired-count 1 --launch-type FARGATE \
  --network-configuration "awsvpcConfiguration={subnets=[<SUBNET_ID>],securityGroups=[<SG_ID>],assignPublicIp=ENABLED}"
```

### Deploying a new version

The task definition targets **ARM64**, so build for `linux/arm64` (native on
Apple Silicon; use `--platform linux/arm64` from an x86 machine/CI, or switch
`cpuArchitecture` to `X86_64` and build `linux/amd64`).

```bash
aws ecr get-login-password --region $AWS_REGION | docker login --username AWS --password-stdin $ECR
docker buildx build --platform linux/arm64 -t $ECR/slack-contract-bot:latest --push .
aws ecs update-service --cluster slack-contract-bot --service slack-contract-bot --force-new-deployment
```

Tail logs with `aws logs tail /ecs/slack-contract-bot --follow`.

The same image also runs on any other container platform (e.g. Railway) —
just provide the environment variables.
