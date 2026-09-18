const SLACK_BTN_PATTERN = "\\[\\[SLACK_BTN\\|([^|\\]]+)\\|(.+?)\\]\\]";
const SLACK_NATIVE_LINK_PATTERN = /^<([^|>]+)\|[^>]*>$/;
const MARKDOWN_LINK_PATTERN = /^\[[^\]]*\]\((https?:\/\/[^)]+)\)$/;
const VALID_HTTP_URL_PATTERN = /^https?:\/\/\S+$/i;

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

/**
 * Extracts the real URL from whatever wrapping the model used. Returns null
 * if nothing resembling a valid http(s) URL can be found — callers must
 * treat that as "no usable link", never fall back to inventing one.
 */
function extractValidUrl(rawCapture: string): string | null {
  const trimmed = rawCapture.trim();

  const markdownLinkMatch = trimmed.match(MARKDOWN_LINK_PATTERN);
  if (markdownLinkMatch) {
    return markdownLinkMatch[1];
  }

  const nativeLinkMatch = trimmed.match(SLACK_NATIVE_LINK_PATTERN);
  if (nativeLinkMatch && VALID_HTTP_URL_PATTERN.test(nativeLinkMatch[1])) {
    return nativeLinkMatch[1];
  }

  if (VALID_HTTP_URL_PATTERN.test(trimmed)) {
    return trimmed;
  }

  return null;
}

export function parseSlackButtons(rawText: string): ParsedSlackMessage {
  // Fresh RegExp instance per call — a shared module-level global regex would
  // carry mutable lastIndex state across concurrent/successive calls.
  const regex = new RegExp(SLACK_BTN_PATTERN, "gs");

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
    const url = extractValidUrl(match[2]);

    if (url) {
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
    } else {
      // No usable URL for this item — render as plain text instead of a
      // broken button, so this one item doesn't take down the whole message
      // (Slack's chat.postMessage rejects the ENTIRE message with
      // invalid_blocks if any button url isn't valid).
      pushTextBlock(`${label} (link unavailable)`);
    }

    lastIndex = regex.lastIndex;
  }

  // Any trailing text after the last button (e.g. "Total ... found: 5")
  pushTextBlock(rawText.slice(lastIndex));

  if (blocks.length === 0) {
    return { text: rawText };
  }

  if (buttonCount === 0) {
    return { text: rawText, blocks };
  }

  return {
    // Slack requires a non-empty top-level "text" fallback even when using blocks
    text: labels.join(", "),
    blocks,
  };
}