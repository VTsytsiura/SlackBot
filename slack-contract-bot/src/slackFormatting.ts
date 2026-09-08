const SLACK_BTN_REGEX = /\[\[SLACK_BTN\|([^|\]]+)\|([^|\]]+)\]\]/g;

interface ButtonSpec {
  label: string;
  url: string;
}

export interface ParsedSlackMessage {
  text: string;
  blocks?: any[];
}

export function parseSlackButtons(rawText: string): ParsedSlackMessage {
  const buttons: ButtonSpec[] = [];

  const cleanedText = rawText
    .replace(SLACK_BTN_REGEX, (_match, label: string, url: string) => {
      buttons.push({ label: label.trim(), url: url.trim() });
      return "";
    })
    .replace(/\s{2,}/g, " ")
    .trim();

  if (buttons.length === 0) {
    return { text: rawText };
  }

  const blocks: any[] = [];

  if (cleanedText) {
    blocks.push({
      type: "section",
      text: { type: "mrkdwn", text: cleanedText },
    });
  }

  for (let i = 0; i < buttons.length; i += 5) {
    const chunk = buttons.slice(i, i + 5);
    blocks.push({
      type: "actions",
      elements: chunk.map((btn, idx) => ({
        type: "button",
        text: { type: "plain_text", text: btn.label, emoji: true },
        url: btn.url,
        action_id: `slack_btn_${i + idx}`,
      })),
    });
  }

  return {
    text: cleanedText || buttons.map((b) => b.label).join(", "),
    blocks,
  };
}