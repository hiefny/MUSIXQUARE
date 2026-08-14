export const PRO_SIGNALING_QUERY_TICKET_CUTOFF_MS: number;

export interface ProSignalingTicketCutoverInput {
  workerSource: string;
  signalingConfig: string;
  adminWorkerSource?: string;
  nowMs?: number;
}

export function validateProSignalingTicketCutover(input: ProSignalingTicketCutoverInput): string[];
