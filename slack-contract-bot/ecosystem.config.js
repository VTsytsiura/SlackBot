const path = require("path");

const root = __dirname;

function bot(name, envFile, port) {
  return {
    name,
    script: path.join(root, "dist", "app.js"),
    cwd: root,
    max_memory_restart: "120M",
    env: {
      DOTENV_CONFIG_PATH: path.join(root, envFile),
      PORT: String(port),
    },
  };
}

module.exports = {
  apps: [
    bot("bot-ibv-slack_agent", ".env.ibv.slack_agent", 3001),
    bot("bot-pdf-slack_agent", ".env.pdf.slack_agent", 3002),
  ],
};