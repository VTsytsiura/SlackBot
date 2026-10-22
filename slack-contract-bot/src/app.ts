import "dotenv/config";
import { App } from "@slack/bolt";
import { createAgentSession, sendMessageToAgent, endAgentSession } from "./agentforce";
import { downloadSalesforceFile, findSalesforceUserIdBySlackId, resolveContentDocumentId } from "./salesforce";
import { startHealthCheckServer } from "./health";
import { generateWorkingMessage } from "./openai";
import { parseSlackButtons } from "./slackFormatting";
import { log } from "./logger";

// Fail fast with a readable message instead of an opaque Slack/Salesforce
// auth error on the first request.
const REQUIRED_ENV = [
  "SLACK_BOT_TOKEN",
  "SLACK_APP_TOKEN",
  "SF_AGENT_CLIENT_ID",
  "SF_AGENT_CLIENT_SECRET",
  "SF_AGENT_ID",
];

const missingEnv = REQUIRED_ENV.filter((name) => !process.env[name]);
if (missingEnv.length > 0) {
  log.error("Missing required environment variables", { missing: missingEnv });
  process.exit(1);
}

const app = new App({
  token: process.env.SLACK_BOT_TOKEN,
  appToken: process.env.SLACK_APP_TOKEN,
  socketMode: true,
  signingSecret: process.env.SLACK_SIGNING_SECRET,
});

interface ConversationState {
  sessionId?: string;
  seq: number;
}

const sessions = new Map<string, ConversationState>();

// Salesforce Id (ContentDocument 069... or ContentVersion 068...) inside a "View Document" button URL.
const VIEW_DOCUMENT_BTN_REGEX = /\[\[SLACK_BTN\|View Document\|([^\]]+?)\]\]/;
const SF_FILE_ID_REGEX = /(06[89][A-Za-z0-9]{12}(?:[A-Za-z0-9]{3})?)/i;

const FILE_LINK_REGEX = /\/document\/download\/([a-zA-Z0-9]{15,18})/;

app.message(async ({ message, say }) => {
  if ((message as any).subtype) return; // ignore edits/system messages

  const channelId = (message as any).channel as string;
  const text = (message as any).text as string;
  const slackUserId = (message as any).user as string | undefined;
  if (!slackUserId) return; // bot/system messages without an author

  // A session bakes in one person's Salesforce Id, so key by channel + user.
  const sessionKey = `${channelId}:${slackUserId}`;

  if (text?.trim() === "/reset") {
    const state = sessions.get(sessionKey);
    if (state?.sessionId) {
      try {
        await endAgentSession(state.sessionId);
      } catch (err) {
        log.warn("Failed to end agent session on reset", { channelId, sessionId: state.sessionId, err });
      }
    }
    sessions.delete(sessionKey);
    log.info("Conversation reset", { channelId });
    await say("Ok, I reset the agent conversation.");
    return;
  }

  let state = sessions.get(sessionKey);
  if (!state) {
    state = { seq: 0 };
    sessions.set(sessionKey, state);
  }

  if (!state.sessionId) {
    try {
      const salesforceUserId = await findSalesforceUserIdBySlackId(slackUserId);
      if (!salesforceUserId) {
        sessions.delete(sessionKey);
        log.warn("No Salesforce user linked to Slack user", { channelId, slackUserId });
        await say("Your Slack account isn't linked to a Salesforce user yet. Please contact your administrator.");
        return;
      }
      state.sessionId = await createAgentSession([
        { name: "sfUserId", type: "Text", value: salesforceUserId },
      ]);
      log.info("Agent session created", { channelId, sessionId: state.sessionId });
    } catch (err) {
      log.error("Failed to create agent session", { channelId, err });
      await say(`❌ Failed to create an agent session: ${(err as Error).message}`);
      return;
    }
  }

  state.seq += 1;

  const placeholder = await say("_Working on it..._");
  const placeholderTs = (placeholder as any).ts as string | undefined;

  generateWorkingMessage(text)
    .then(async (smartText) => {
      if (smartText && placeholderTs) {
        try {
          await app.client.chat.update({ channel: channelId, ts: placeholderTs, text: `_${smartText}_` });
        } catch (err) {
          log.warn("Failed to update working placeholder", { channelId, err });
        }
      }
    })
    .catch((err) => {
      log.warn("Working message generation failed", { channelId, err });
    });

  try {
    const replyTexts = await sendMessageToAgent(state.sessionId, text, state.seq);

    for (const replyText of replyTexts) {
      const fileMatch = replyText.match(FILE_LINK_REGEX);

      if (fileMatch) {
        const contentDocumentId = fileMatch[1];

        try {
          const { data, fileName } = await downloadSalesforceFile(contentDocumentId);
          const cleanedText = replyText.replace(FILE_LINK_REGEX, "").trim();

          await app.client.files.uploadV2({
            channel_id: channelId,
            file: data,
            filename: fileName,
            initial_comment: cleanedText || `Here is the generated file: ${fileName}`,
          });
          log.info("Uploaded generated file", { channelId, contentDocumentId });
        } catch (fileErr) {
          log.error("Failed to attach generated file", { channelId, contentDocumentId, err: fileErr });
          await say(replyText);
          await say(`⚠️ Could not attach the file directly: ${(fileErr as Error).message}`);
        }
      } else {
        const parsed = parseSlackButtons(replyText);
        if (parsed.blocks) {
          await say({ text: parsed.text, blocks: parsed.blocks });
        } else {
          await say(parsed.text);
        }

        // Post an inline preview of the generated document right after the button message.
        const viewBtn = replyText.match(VIEW_DOCUMENT_BTN_REGEX);
        if (viewBtn) {
          const idMatch = viewBtn[1].match(SF_FILE_ID_REGEX);
          let previewPosted = false;
          if (idMatch) {
            try {
              const contentDocumentId = await resolveContentDocumentId(idMatch[1]);
              if (contentDocumentId) {
                const { data, fileName } = await downloadSalesforceFile(contentDocumentId);
                await app.client.files.uploadV2({
                  channel_id: channelId,
                  file: data,
                  filename: fileName,
                });
                previewPosted = true;
                log.info("Uploaded document preview", { channelId, contentDocumentId });
              }
            } catch (previewErr) {
              log.warn("Could not upload document preview", { channelId, err: previewErr });
            }
          }
          if (!previewPosted) {
            // The agent answer and the View Document button are already shown; just tell the user.
            await say("_Preview is not available for this document._");
          }
        }
      }
    }
  } catch (err) {
    log.error("Agent communication failed", { channelId, sessionId: state.sessionId, err });
    await say(`❌ Agent communication error: ${(err as Error).message}`);
  }
});

async function shutdown(signal: string): Promise<void> {
  log.info("Shutting down", { signal });
  try {
    await app.stop();
    process.exit(0);
  } catch (err) {
    log.error("Error during shutdown", { err });
    process.exit(1);
  }
}

// ECS sends SIGTERM on deploys/scale-in and SIGKILLs after stopTimeout.
process.once("SIGTERM", () => void shutdown("SIGTERM"));
process.once("SIGINT", () => void shutdown("SIGINT"));

// Same outcome as Node's default for these, but logged as structured JSON;
// the non-zero exit lets ECS restart the task.
process.on("unhandledRejection", (reason) => {
  log.error("Unhandled promise rejection", { err: reason });
  process.exit(1);
});
process.on("uncaughtException", (err) => {
  log.error("Uncaught exception", { err });
  process.exit(1);
});

(async () => {
  startHealthCheckServer();
  await app.start();
  log.info("Slack bot is running", { mode: "socket" });
})().catch((err) => {
  log.error("Failed to start Slack bot", { err });
  process.exit(1);
});