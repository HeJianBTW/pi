import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';

export type RequestHandler = (
  request: IncomingMessage,
  response: ServerResponse,
  body: string,
) => void | Promise<void>;

export function readBody(request: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    request.on('data', (chunk: Buffer) => chunks.push(chunk));
    request.on('error', reject);
    request.on('end', () => resolve(Buffer.concat(chunks).toString('utf-8')));
  });
}

export async function startHttpEndpoint(options: {
  host: string;
  port: number;
  path: string;
  handler: RequestHandler;
}): Promise<Server> {
  const server = createServer(async (request, response) => {
    const url = new URL(request.url ?? '/', `http://${request.headers.host ?? 'localhost'}`);
    if (url.pathname !== options.path) {
      response.writeHead(404).end('not found');
      return;
    }
    try {
      const body =
        request.method === 'GET' || request.method === 'HEAD' ? '' : await readBody(request);
      await options.handler(request, response, body);
    } catch (error) {
      response.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
      response.end(error instanceof Error ? error.message : String(error));
    }
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(options.port, options.host, () => {
      server.off('error', reject);
      resolve();
    });
  });
  return server;
}

export function jsonResponse(response: ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  response.end(JSON.stringify(body));
}
