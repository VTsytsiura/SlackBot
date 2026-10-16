import { log } from "./logger";

const SF_AGENT_CLIENT_ID = process.env.SF_AGENT_CLIENT_ID || "";
const SF_AGENT_CLIENT_SECRET = process.env.SF_AGENT_CLIENT_SECRET || "";
const SF_LOGIN_URL = process.env.SF_AGENT_LOGIN_URL || "https://login.salesforce.com";

interface SfTokenResponse {
  access_token: string;
  instance_url: string;
}

interface SalesforceFile {
  data: Buffer;
  fileName: string;
  contentType: string;
}

let cachedToken: { accessToken: string; instanceUrl: string; expiresAt: number } | null = null;

async function assertOk(response: Response, label: string): Promise<void> {
  if (!response.ok) {
    throw new Error(`${label} failed: ${response.status} ${await response.text()}`);
  }
}

// Client Credentials Flow — same ECA/credentials as agentforce.ts uses for Agent API
async function getAccessToken(): Promise<{ accessToken: string; instanceUrl: string }> {
  if (cachedToken && cachedToken.expiresAt > Date.now()) {
    return { accessToken: cachedToken.accessToken, instanceUrl: cachedToken.instanceUrl };
  }

  const response = await fetch(`${SF_LOGIN_URL}/services/oauth2/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "client_credentials",
      client_id: SF_AGENT_CLIENT_ID,
      client_secret: SF_AGENT_CLIENT_SECRET,
    }),
  });

  await assertOk(response, "SF auth");

  const data = (await response.json()) as SfTokenResponse;

  cachedToken = {
    accessToken: data.access_token,
    instanceUrl: data.instance_url,
    expiresAt: Date.now() + 100 * 60 * 1000,
  };

  return { accessToken: data.access_token, instanceUrl: data.instance_url };
}

export async function downloadSalesforceFile(contentDocumentId: string): Promise<SalesforceFile> {
  const { accessToken, instanceUrl } = await getAccessToken();

  const soql = `SELECT Id, Title, FileExtension FROM ContentVersion WHERE ContentDocumentId = '${contentDocumentId}' AND IsLatest = true LIMIT 1`;
  const queryResponse = await fetch(
    `${instanceUrl}/services/data/v60.0/query?q=${encodeURIComponent(soql)}`,
    { headers: { Authorization: `Bearer ${accessToken}` } }
  );

  await assertOk(queryResponse, "ContentVersion query");

  const queryData = await queryResponse.json();
  const record = queryData.records?.[0];

  if (!record) {
    throw new Error(`No ContentVersion found for ContentDocumentId ${contentDocumentId}`);
  }

  const versionId = record.Id;
  const extension = record.FileExtension || "pdf";
  const fileName = `${record.Title}.${extension}`;

  const fileResponse = await fetch(
    `${instanceUrl}/services/data/v60.0/sobjects/ContentVersion/${versionId}/VersionData`,
    { headers: { Authorization: `Bearer ${accessToken}` } }
  );

  await assertOk(fileResponse, "File download");

  const arrayBuffer = await fileResponse.arrayBuffer();
  const data = Buffer.from(arrayBuffer);

  const contentType = extension.toLowerCase() === "pdf" ? "application/pdf" : "application/octet-stream";

  return { data, fileName, contentType };
}
// ---- Slack user -> Salesforce user mapping (User.Slack_User_Id__c) ----

const USER_CACHE_TTL_MS = 10 * 60 * 1000;
const userIdCache = new Map<string, { sfUserId: string; expiresAt: number }>();

// Returns the Salesforce User Id for a Slack user id, or null if there is no
// match (or more than one — ambiguous). Only successful lookups are cached,
// so linking a user in Salesforce takes effect immediately.
export async function findSalesforceUserIdBySlackId(slackUserId: string): Promise<string | null> {
  if (!/^[A-Za-z0-9]+$/.test(slackUserId)) {
    log.warn("Rejected malformed Slack user id", { slackUserId });
    return null;
  }

  const cached = userIdCache.get(slackUserId);
  if (cached && cached.expiresAt > Date.now()) {
    return cached.sfUserId;
  }

  const { accessToken, instanceUrl } = await getAccessToken();
  const soql = `SELECT Id FROM User WHERE Slack_User_Id__c = '${slackUserId}' AND IsActive = true LIMIT 2`;
  const response = await fetch(
    `${instanceUrl}/services/data/v60.0/query?q=${encodeURIComponent(soql)}`,
    { headers: { Authorization: `Bearer ${accessToken}` } }
  );
  await assertOk(response, "User lookup");

  const data = (await response.json()) as { records?: Array<{ Id: string }> };
  const records = data.records || [];

  if (records.length === 0) return null;
  if (records.length > 1) {
    log.warn("Multiple Salesforce users share one Slack_User_Id__c", { slackUserId });
    return null;
  }

  userIdCache.set(slackUserId, { sfUserId: records[0].Id, expiresAt: Date.now() + USER_CACHE_TTL_MS });
  return records[0].Id;
}