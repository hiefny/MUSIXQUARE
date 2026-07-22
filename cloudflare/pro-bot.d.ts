export type ProBotPlan = Record<string, unknown>;

export function handleProBotRequest(
  request: Request,
  env: unknown,
  options: unknown,
): Promise<Response>;

export const proBotInternalsForTests: {
  BOT_MAX_TRACKS: number;
  modelName(env: unknown): string;
  buildGroundedContext(...args: unknown[]): unknown;
  buildPlan(
    prompt: string,
    context: unknown,
    language: string,
    env: unknown,
    signal: AbortSignal,
  ): Promise<ProBotPlan | null>;
  explicitlyRequestsDeletion(prompt: string): boolean;
  explicitlyRequestsPlayback(prompt: string): boolean;
  explicitlyRequestsQueueClear(prompt: string): boolean;
  actionNotConfirmedAnswer(...args: unknown[]): string;
  isTrackRequestPrompt(prompt: string): boolean;
  isVirtualTrebleControlPrompt(prompt: string): boolean;
  normalizePlanForExecution(prompt: string, plan: ProBotPlan): ProBotPlan;
  parsePlan(value: unknown): ProBotPlan | null;
  planExplicitQueueOrdinal(...args: unknown[]): number | null;
  planMatchesPromptScope(prompt: string, plan: ProBotPlan): boolean;
  requestedQueueOrdinal(...args: unknown[]): number | null;
  requiresGrounding(...args: unknown[]): boolean;
  resolveTracks(
    plan: ProBotPlan,
    env: unknown,
    signal: AbortSignal,
  ): Promise<{
    tracks: Array<{
      videoId: string;
      name: string;
      title: string;
      artist: string;
      thumbnail: string;
    }>;
    playAddedIndex: number;
  }>;
};
