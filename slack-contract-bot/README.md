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
- `src/salesforce.ts` — Salesforce REST API client (opportunity updates,
  downloading generated files via ContentVersion).
- `src/health.ts` — minimal HTTP server exposing `GET /health` (and `GET /`)
  so hosting platforms can healthcheck the process. The bot itself only
  communicates with Slack over Socket Mode; this server does not carry any
  bot traffic.

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

Copy `.env.example` to `.env` and fill in real values locally. In Railway,
set the same keys under **Project → Variables**:

- `SLACK_BOT_TOKEN`
- `SLACK_APP_TOKEN`
- `SLACK_SIGNING_SECRET`
- `SF_AGENT_CLIENT_ID`
- `SF_AGENT_CLIENT_SECRET`
- `SF_AGENT_ID`
- `SF_AGENT_LOGIN_URL`
- `PORT` — optional; Railway sets this automatically for the health check server.

## Deployment

Deploys via [Railway](https://railway.app), which auto-detects the
`Dockerfile` in this repo (falls back to a Node buildpack if the Dockerfile
is removed). The same Dockerfile is portable to any container platform
(e.g. AWS ECS/Fargate) with no changes.

The image is a multi-stage build:
1. **build** stage — installs all dependencies and compiles TypeScript to `dist/`.
2. **runtime** stage — installs only production dependencies and copies in
   the compiled `dist/`, then runs `node dist/app.js`.
