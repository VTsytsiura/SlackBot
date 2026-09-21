type Level = "debug" | "info" | "warn" | "error";
type Meta = Record<string, unknown>;

const LEVEL_RANK: Record<Level, number> = { debug: 10, info: 20, warn: 30, error: 40 };

const MIN_RANK = LEVEL_RANK[(process.env.LOG_LEVEL || "info").toLowerCase() as Level] ?? LEVEL_RANK.info;

function serializeError(err: unknown): Meta {
  if (err instanceof Error) {
    return { name: err.name, message: err.message, stack: err.stack };
  }
  return { message: String(err) };
}

// One JSON object per line — CloudWatch Logs (and Logs Insights) parse this
// natively. Pass an error as `{ err }` and it is serialized with its stack.
function write(level: Level, msg: string, meta: Meta = {}): void {
  if (LEVEL_RANK[level] < MIN_RANK) return;

  const { err, ...fields } = meta;
  const entry = {
    time: new Date().toISOString(),
    level,
    msg,
    ...fields,
    ...(err !== undefined ? { err: serializeError(err) } : {}),
  };

  const sink = level === "error" || level === "warn" ? console.error : console.log;
  sink(JSON.stringify(entry));
}

export const log = {
  debug: (msg: string, meta?: Meta) => write("debug", msg, meta),
  info: (msg: string, meta?: Meta) => write("info", msg, meta),
  warn: (msg: string, meta?: Meta) => write("warn", msg, meta),
  error: (msg: string, meta?: Meta) => write("error", msg, meta),
};
