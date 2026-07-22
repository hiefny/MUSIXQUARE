export class MusixquareRoom {
  constructor(state: unknown, env?: Record<string, unknown>);
  fetch(request: Request): Promise<Response>;
  webSocketMessage(socket: unknown, raw: unknown): Promise<void>;
  webSocketClose(socket: unknown): Promise<void>;
  alarm(): Promise<void>;
}

declare const worker: {
  fetch(request: Request, env: Record<string, unknown>): Promise<Response>;
};
export default worker;
