import { createServer } from 'node:http';
export function readBody(request) {
    return new Promise((resolve, reject) => {
        const chunks = [];
        request.on('data', (chunk) => chunks.push(chunk));
        request.on('error', reject);
        request.on('end', () => resolve(Buffer.concat(chunks).toString('utf-8')));
    });
}
export async function startHttpEndpoint(options) {
    const server = createServer(async (request, response) => {
        const url = new URL(request.url ?? '/', `http://${request.headers.host ?? 'localhost'}`);
        if (url.pathname !== options.path) {
            response.writeHead(404).end('not found');
            return;
        }
        try {
            const body = request.method === 'GET' || request.method === 'HEAD' ? '' : await readBody(request);
            await options.handler(request, response, body);
        }
        catch (error) {
            response.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
            response.end(error instanceof Error ? error.message : String(error));
        }
    });
    await new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(options.port, options.host, () => {
            server.off('error', reject);
            resolve();
        });
    });
    return server;
}
export function jsonResponse(response, status, body) {
    response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
    response.end(JSON.stringify(body));
}
//# sourceMappingURL=http.js.map