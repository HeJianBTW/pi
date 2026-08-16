import { type IncomingMessage, type Server, type ServerResponse } from 'node:http';
export type RequestHandler = (request: IncomingMessage, response: ServerResponse, body: string) => void | Promise<void>;
export declare function readBody(request: IncomingMessage): Promise<string>;
export declare function startHttpEndpoint(options: {
    host: string;
    port: number;
    path: string;
    handler: RequestHandler;
}): Promise<Server>;
export declare function jsonResponse(response: ServerResponse, status: number, body: unknown): void;
//# sourceMappingURL=http.d.ts.map