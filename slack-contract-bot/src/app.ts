import "dotenv/config";
import { App } from "@slack/bolt";
import { createAgentSession, sendMessageToAgent, endAgentSession } from "./agentforce";
import { downloadSalesforceFile } from "./salesforce";
import { startHealthCheckServer } from "./health";
import { generateWorkingMessage } from "./openai";

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

// Matches a Salesforce file download link, e.g.
// https://.../sfc/servlet.shepherd/document/download/069XXXXXXXXXXXXXXX
const FILE_LINK_REGEX = /\/document\/download\/([a-zA-Z0-9]{15,18})/;

app.message(async ({ message, say }) => {
  if ((message as any).subtype) return; // ignore edits/system messages

  const channelId = (message as any).channel as string;
  const text = (message as any).text as string;

  if (text === "/reset") {
    const state = sessions.get(channelId);
    if (state?.sessionId) {
      try {
        await endAgentSession(state.sessionId);
      } catch {
      }
    }
    sessions.delete(channelId);
    await say("Ok, I reset the agent conversation.");
    return;
  }

  let state = sessions.get(channelId);
  if (!state) {
    state = { seq: 0 };
    sessions.set(channelId, state);
  }

  if (!state.sessionId) {
    try {
      state.sessionId = await createAgentSession();
    } catch (err) {
      await say(`❌ Failed to create an agent session: ${(err as Error).message}`);
      return;
    }
  }

  state.seq += 1;

  // Post an immediate generic placeholder — guaranteed instant feedback,
  // independent of both the agent call and the OpenAI call below.
  const placeholder = await say("_Working on it..._");
  const placeholderTs = (placeholder as any).ts as string | undefined;

  // Once true, the OpenAI-driven placeholder update (below) must never fire —
  // the real result has already been posted and must not be overwritten.
  let finalized = false;

  // Fire the OpenAI call in PARALLEL with the agent call — never awaited
  // before starting the agent request. If it resolves before the agent does
  // (and the agent hasn't finished yet), upgrade the generic placeholder to
  // a more specific one. If it's slower than the agent, or fails/times out,
  // this simply does nothing.
  generateWorkingMessage(text)
    .then(async (smartText) => {
      if (smartText && !finalized && placeholderTs) {
        try {
          await app.client.chat.update({ channel: channelId, ts: placeholderTs, text: `_${smartText}_` });
        } catch {
          // ignore — not worth failing the whole flow over a cosmetic update
        }
      }
    })
    .catch(() => {
      // openai.ts already swallows its own errors and returns null; this is
      // just an extra safety net.
    });

  try {
    // sendMessageToAgent now returns ALL messages the agent produced this turn
    // (e.g. an intermediate "Sure, generating the contract now..." acknowledgment
    // followed by the final result) — send each one to Slack, in order.
    const replyTexts = await sendMessageToAgent(state.sessionId, text, state.seq);

    let placeholderConsumed = false;

    for (const replyText of replyTexts) {
      const fileMatch = replyText.match(FILE_LINK_REGEX);

      if (fileMatch) {
        const contentDocumentId = fileMatch[1];

        try {
          const { data, fileName } = await downloadSalesforceFile(contentDocumentId);
          const cleanedText = replyText.replace(FILE_LINK_REGEX, "").trim();

          if (placeholderTs && !placeholderConsumed) {
            finalized = true;
            await app.client.chat.delete({ channel: channelId, ts: placeholderTs });
            placeholderConsumed = true;
          }

          await app.client.files.uploadV2({
            channel_id: channelId,
            file: data,
            filename: fileName,
            initial_comment: cleanedText || `Here is the generated file: ${fileName}`,
          });
        } catch (fileErr) {
          // Fall back to plain text (with the link as-is) if the file couldn't be attached
          finalized = true;
          await say(replyText);
          await say(`⚠️ Could not attach the file directly: ${(fileErr as Error).message}`);
        }
      } else if (placeholderTs && !placeholderConsumed) {
        finalized = true;
        await app.client.chat.update({ channel: channelId, ts: placeholderTs, text: replyText });
        placeholderConsumed = true;
      } else {
        await say(replyText);
      }
    }

    finalized = true;
  } catch (err) {
    finalized = true;
    const errorText = `❌ Agent communication error: ${(err as Error).message}`;
    if (placeholderTs) {
      await app.client.chat.update({ channel: channelId, ts: placeholderTs, text: errorText });
    } else {
      await say(errorText);
    }
  }
});

(async () => {
  startHealthCheckServer();
  await app.start();
  console.log("⚡️ Slack bot is running (Socket Mode)");
})();