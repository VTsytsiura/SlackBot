import "dotenv/config";
import { App } from "@slack/bolt";
import { createAgentSession, sendMessageToAgent, endAgentSession } from "./agentforce";
import { downloadSalesforceFile } from "./salesforce";
import { startHealthCheckServer } from "./health";
import { generateWorkingMessage } from "./openai";
import { parseSlackButtons } from "./slackFormatting";

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

  const placeholder = await say("_Working on it..._");
  const placeholderTs = (placeholder as any).ts as string | undefined;

  generateWorkingMessage(text)
    .then(async (smartText) => {
      if (smartText && placeholderTs) {
        try {
          await app.client.chat.update({ channel: channelId, ts: placeholderTs, text: `_${smartText}_` });
        } catch {
        }
      }
    })
    .catch(() => {
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
        } catch (fileErr) {
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
      }
    }
  } catch (err) {
    await say(`❌ Agent communication error: ${(err as Error).message}`);
  }
});

(async () => {
  startHealthCheckServer();
  await app.start();
  console.log("⚡️ Slack bot is running (Socket Mode)");
})();