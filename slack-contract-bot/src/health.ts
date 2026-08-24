import http from "http";

// Railway expects the process to listen on $PORT and respond to health checks.
// The bot itself talks to Slack over Socket Mode (no inbound HTTP), so this
// server exists purely to satisfy the platform's healthcheck.
export function startHealthCheckServer(): void {
  const port = Number(process.env.PORT) || 3000;

  const server = http.createServer((req, res) => {
    if (req.method === "GET" && (req.url === "/health" || req.url === "/")) {
      res.writeHead(200, { "Content-Type": "text/plain" });
      res.end("OK");
      return;
    }

    res.writeHead(404, { "Content-Type": "text/plain" });
    res.end("Not found");
  });

  server.listen(port, () => {
    console.log(`🩺 Health check server listening on port ${port}`);
  });
}
