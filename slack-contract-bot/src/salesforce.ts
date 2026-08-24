const SF_AGENT_CLIENT_ID = process.env.SF_AGENT_CLIENT_ID || "";
const SF_AGENT_CLIENT_SECRET = process.env.SF_AGENT_CLIENT_SECRET || "";
const SF_LOGIN_URL = process.env.SF_AGENT_LOGIN_URL || "https://login.salesforce.com";

interface SfTokenResponse {
  access_token: string;
  instance_url: string;
}

interface OpportunityUpdateResponse {
  success: boolean;
  message: string;
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

export async function updateOpportunityStage(
  opportunityId: string,
  newStage: string
): Promise<OpportunityUpdateResponse> {
  const { accessToken, instanceUrl } = await getAccessToken();

  const response = await fetch(`${instanceUrl}/services/apexrest/OpportunityBot/`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ opportunityId, newStage }),
  });

  await assertOk(response, "Opportunity stage update");

  return (await response.json()) as OpportunityUpdateResponse;
}

export async function downloadSalesforceFile(contentDocumentId: string): Promise<SalesforceFile> {
  const { accessToken, instanceUrl } = await getAccessToken();

  // 1. Find the latest ContentVersion for this ContentDocumentId
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

  // 2. Download the binary file content
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