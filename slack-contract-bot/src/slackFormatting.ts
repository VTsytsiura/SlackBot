const SLACK_BTN_PATTERN = "\\[\\[SLACK_BTN\\|([^|\\]]+)\\|([^|\\]]+)\\]\\]";

export interface ParsedSlackMessage {
  text: string;
  blocks?: any[];
}

function normalizeWhitespace(segment: string): string {
  return segment
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .join("\n")
    .trim();
}

export function parseSlackButtons(rawText: string): ParsedSlackMessage {
  // Fresh RegExp instance per call — a shared module-level global regex would
  // carry mutable lastIndex state across concurrent/successive calls.
  const regex = new RegExp(SLACK_BTN_PATTERN, "g");

  const blocks: any[] = [];
  const labels: string[] = [];
  let lastIndex = 0;
  let buttonCount = 0;
  let match: RegExpExecArray | null;

  const pushTextBlock = (segment: string) => {
    const normalized = normalizeWhitespace(segment);
    if (normalized) {
      blocks.push({ type: "section", text: { type: "mrkdwn", text: normalized } });
    }
  };

  while ((match = regex.exec(rawText)) !== null) {
    // Text that appeared before this button — its own section block
    pushTextBlock(rawText.slice(lastIndex, match.index));

    const label = match[1].trim();
    const url = match[2].trim();
    labels.push(label);
    buttonCount += 1;

    blocks.push({
      type: "actions",
      elements: [
        {
          type: "button",
          text: { type: "plain_text", text: label, emoji: true },
          url,
          action_id: `slack_btn_${buttonCount}`,
        },
      ],
    });

    lastIndex = regex.lastIndex;
  }

  // Any trailing text after the last button (e.g. "Total ... found: 5")
  pushTextBlock(rawText.slice(lastIndex));

  if (buttonCount === 0) {
    return { text: rawText };
  }

  return {
    // Slack requires a non-empty top-level "text" fallback even when using blocks
    text: labels.join(", "),
    blocks,
  };
}