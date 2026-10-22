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

// Restores the original letter case of an 18-char Salesforce Id whose case was lost
// (e.g. lowercased by the LLM/Slack). The 3-char suffix encodes the case of the first 15 chars.
// Returns the input unchanged if it is not an 18-char Id or the suffix does not validate.
export function restoreSalesforceIdCase(id: string): string {
  if (!/^[A-Za-z0-9]{18}$/.test(id)) return id;
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ012345";
  const base = id.slice(0, 15).toLowerCase();
  const suffix = id.slice(15).toUpperCase();
  let restored = "";
  for (let chunk = 0; chunk < 3; chunk++) {
    const bits = alphabet.indexOf(suffix[chunk]);
    if (bits < 0) return id;
    for (let i = 0; i < 5; i++) {
      const ch = base[chunk * 5 + i];
      restored += bits & (1 << i) ? ch.toUpperCase() : ch;
    }
  }
  // Verify: re-encode the restored Id and compare with the suffix
  let check = "";
  for (let chunk = 0; chunk < 3; chunk++) {
    let bits = 0;
    for (let i = 0; i < 5; i++) {
      const ch = restored[chunk * 5 + i];
      if (ch >= "A" && ch <= "Z") bits |= 1 << i;
    }
    check += alphabet[bits];
  }
  return check === suffix ? restored + suffix : id;
}

// Accepts a ContentDocument Id (069...) or a ContentVersion Id (068...) and
// returns the ContentDocument Id, or null if it cannot be resolved.
export async function resolveContentDocumentId(rawId: string): Promise<string | null> {
  if (!/^[A-Za-z0-9]{15,18}$/.test(rawId)) return null;
  const id = restoreSalesforceIdCase(rawId);
  if (id.startsWith("069")) return id;
  if (!id.startsWith("068")) return null;

  const { accessToken, instanceUrl } = await getAccessToken();
  const soql = `SELECT ContentDocumentId FROM ContentVersion WHERE Id = '${id}' LIMIT 1`;
  const response = await fetch(
    `${instanceUrl}/services/data/v60.0/query?q=${encodeURIComponent(soql)}`,
    { headers: { Authorization: `Bearer ${accessToken}` } }
  );
  await assertOk(response, "ContentVersion lookup");
  const data = await response.json();
  return data.records?.[0]?.ContentDocumentId ?? null;
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