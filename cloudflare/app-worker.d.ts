declare const appWorker: {
  fetch(request: Request, env: unknown, context?: unknown): Promise<Response>;
  scheduled(
    event: unknown,
    env: unknown,
    context: { waitUntil(promise: Promise<unknown>): void },
  ): Promise<void>;
};

export function sanitizeSoroArticleHtmlForTests(html: string): string;
export default appWorker;
