export * from './discoveryEngine.js';
import { discoveryEngine, type DiscoveryRequest } from './discoveryEngine.js';
import type { Request, Response } from 'express';

export type TargetFulfillmentOptions = {
  req: Request;
  res: Response;
  sessionId: string;
  promptQuery: string;
  requestedLimit: number;
  startedAt?: number;
  sessionAbortController?: AbortController;
  activeSessions?: Map<string, string[]>;
  activeSessionControllers?: Map<string, AbortController>;
  activeSessionEvents?: Map<string, any[]>;
  cancelledSessions?: Set<string>;
};

export async function executeTargetFulfillmentSession(options: TargetFulfillmentOptions): Promise<any> {
  const result = await discoveryEngine.execute({
    sessionId: options.sessionId,
    promptQuery: options.promptQuery,
    requestedLimit: options.requestedLimit
  });
  return options.res.status(200).json(result);
}
