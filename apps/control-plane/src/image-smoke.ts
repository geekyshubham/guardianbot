import { createServer, type Server } from "node:http";

function validPort(value: number): number {
  if (!Number.isInteger(value) || value < 1 || value > 65_535) {
    throw new Error("Image smoke port must be an integer from 1 through 65535");
  }
  return value;
}

export function createImageSmokeServer(): Server {
  return createServer((request, response) => {
    response.setHeader("cache-control", "no-store, max-age=0");
    response.setHeader("content-type", "application/json");
    if (
      request.method === "GET" &&
      (request.url === "/healthz" || request.url === "/readyz")
    ) {
      response.writeHead(200).end(JSON.stringify({ status: "ok", mode: "image-smoke" }));
      return;
    }
    response.writeHead(404).end(JSON.stringify({ error: "not found" }));
  });
}

export async function startImageSmokeServer(port: number): Promise<Server> {
  const server = createImageSmokeServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(validPort(port), "0.0.0.0", () => {
      server.off("error", reject);
      resolve();
    });
  });
  return server;
}
