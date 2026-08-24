const SF_LOGIN_URL = process.env.SF_AGENT_LOGIN_URL || "https://login.salesforce.com";
const AGENT_API_BASE = "https://api.salesforce.com/einstein/ai-agent/v1";

interface AgentOAuthTokenResponse {
  access_token: string;
  token_type: string;
  instance_url?: string;
}

interface AgentSessionResponse {
  sessionId: string;
}

interface AgentApiMessage {
  type: string;
  message?: string;
}

interface AgentSendMessageResponse {
  messages?: AgentApiMessage[];
}

let cachedAgentToken: { accessToken: string; expiresAt: number } | null = null;

async function assertOk(response: Response, label: string): Promise<void> {
  if (!response.ok) {
    throw new Error(`${label} failed: ${response.status} ${await response.text()}`);
  }
}

async function getAgentApiToken(): Promise<string> {
  if (cachedAgentToken && cachedAgentToken.expiresAt > Date.now()) {
    return cachedAgentToken.accessToken;
  }

  const response = await fetch(`${SF_LOGIN_URL}/services/oauth2/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "client_credentials",
      client_id: process.env.SF_AGENT_CLIENT_ID || "",
      client_secret: process.env.SF_AGENT_CLIENT_SECRET || "",
    }),
  });

  await assertOk(response, "Agent auth");

  const data = (await response.json()) as AgentOAuthTokenResponse;
  cachedAgentToken = {
    accessToken: data.access_token,
    expiresAt: Date.now() + 100 * 60 * 1000,
  };
  return data.access_token;
}

/**
 * Opens a new Agentforce Agent API session for the configured agent.
 * Returns the session ID used by {@link sendMessageToAgent} and {@link endAgentSession}.
 */
export async function createAgentSession(): Promise<string> {
  const token = await getAgentApiToken();
  const agentId = process.env.SF_AGENT_ID || "";

  const response = await fetch(`${AGENT_API_BASE}/agents/${agentId}/sessions`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      externalSessionKey: crypto.randomUUID(),
      instanceConfig: { endpoint: SF_LOGIN_URL },
      streamingCapabilities: { chunkTypes: ["Text"] },
      bypassUser: true,
    }),
  });

  await assertOk(response, "Session creation");

  const data = (await response.json()) as AgentSessionResponse;
  return data.sessionId;
}

/**
 * Sends a user message to the agent and returns ALL text messages the agent
 * produced during this turn, in order (e.g. an intermediate "Sure, generating
 * the contract now..." acknowledgment followed by the final result message).
 * Previously this only returned the first message, silently dropping any
 * others returned in the same API response.
 */
export async function sendMessageToAgent(
  sessionId: string,
  text: string,
  sequenceId: number
): Promise<string[]> {
  const token = await getAgentApiToken();

  const response = await fetch(`${AGENT_API_BASE}/sessions/${sessionId}/messages`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      message: { sequenceId, type: "Text", text },
    }),
  });

  await assertOk(response, "Send message");

  const data = (await response.json()) as AgentSendMessageResponse;

  const textMessages = (data.messages || [])
    .filter((m) => (m.type === "Inform" || m.type === "Text") && !!m.message)
    .map((m) => m.message as string);

  return textMessages.length > 0 ? textMessages : [JSON.stringify(data)];
}

export async function endAgentSession(sessionId: string): Promise<void> {
  const token = await getAgentApiToken();
  const response = await fetch(`${AGENT_API_BASE}/sessions/${sessionId}`, {
    method: "DELETE",
    headers: { Authorization: `Bearer ${token}` },
  });

  await assertOk(response, "Session termination");
}