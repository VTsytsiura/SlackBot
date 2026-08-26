const OPENAI_API_KEY = process.env.OPENAI_API_KEY || "";
const OPENAI_MODEL = process.env.OPENAI_MODEL || "gpt-4o-mini";
const TIMEOUT_MS = 1500; 

export async function generateWorkingMessage(userText: string): Promise<string | null> {
  if (!OPENAI_API_KEY) {
    return null;
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), TIMEOUT_MS);

  try {
    const response = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${OPENAI_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: OPENAI_MODEL,
        max_tokens: 20,
        temperature: 0.3,
        messages: [
          {
            role: "system",
            content:
              "You write a single short status line (under 10 words, present continuous tense) describing what you're about to do based on a user's request. Examples: 'Sure, generating the contract for SlackTeams...', 'Updating the opportunity stage now...'. Output only the line itself, no quotes, no extra text.",
          },
          { role: "user", content: userText },
        ],
      }),
      signal: controller.signal,
    });

    clearTimeout(timeout);

    if (!response.ok) {
      return null;
    }

    const data = await response.json();
    const text = data.choices?.[0]?.message?.content?.trim();
    return text || null;
  } catch (err) {
    clearTimeout(timeout);
    return null;
  }
}
