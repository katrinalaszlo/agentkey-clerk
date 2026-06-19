import type { Request, Response, NextFunction } from "express";
import type {
  AgentKey,
  ValidateResult,
  EnsureSubjectOptions,
} from "@katrinalaszlo/agentkey";

// Minimal shape of a verified Clerk M2M token (the result of
// `clerkClient.m2m.verify({ token })`). Declared structurally so this package
// has no hard dependency on @clerk/backend — the consumer passes in their own
// Clerk client. See https://clerk.com/docs/guides/development/machine-auth/m2m-tokens
export interface VerifiedM2MToken {
  id: string;
  subject: string;
  scopes?: string[];
  claims?: Record<string, unknown> | null;
  revoked?: boolean;
  expired?: boolean;
  expiration?: number | null;
}

// The slice of the Clerk client this middleware calls. Pass a real
// `createClerkClient(...)` instance; it satisfies this shape.
export interface ClerkM2MClient {
  m2m: { verify(params: { token: string }): Promise<VerifiedM2MToken> };
}

export interface ClerkAgentKeyOptions {
  clerkClient: ClerkM2MClient;
  ak: AgentKey;
  // Scope/budget/expiry applied when a machine is seen for the first time.
  defaults?: EnsureSubjectOptions;
  // Per-machine override computed from the verified token. Takes precedence over
  // `defaults` when provided.
  onFirstSeen?: (token: VerifiedM2MToken) => EnsureSubjectOptions;
  // Optional agentkey capability scope the route requires. This is an agentkey
  // scope (what the agent may do), distinct from Clerk's machine-to-machine
  // communication scopes.
  scope?: string;
}

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      m2m?: VerifiedM2MToken;
      agentKey?: ValidateResult;
    }
  }
}

// Express middleware: verify the incoming Clerk M2M token, then enforce
// agentkey's budget/scope/expiry on the machine behind it. Clerk says *who* the
// machine is; agentkey says *how much it may spend and do*. On first sight of a
// machine, its budget row is provisioned from `onFirstSeen`/`defaults`.
export function clerkAgentKeyMiddleware(opts: ClerkAgentKeyOptions) {
  const { clerkClient, ak, defaults, onFirstSeen, scope } = opts;

  return async (req: Request, res: Response, next: NextFunction) => {
    try {
      const authHeader = req.headers.authorization;
      if (!authHeader?.startsWith("Bearer ")) {
        return res.status(401).json({ error: "Missing M2M token" });
      }

      const token = authHeader.slice(7);
      const verified = await clerkClient.m2m.verify({ token });

      // Clerk already computed these; don't re-derive them.
      if (verified.revoked || verified.expired) {
        return res.status(401).json({ error: "invalid_token" });
      }

      const subject = verified.subject;
      let result = await ak.validateBySubject(subject);

      // First time we've seen this machine: provision its budget row, then
      // re-validate. ensureSubject is idempotent, so a concurrent first request
      // racing on the same machine is safe.
      if (!result.valid && result.reason === "invalid") {
        await ak.ensureSubject(subject, onFirstSeen?.(verified) ?? defaults ?? {});
        result = await ak.validateBySubject(subject);
      }

      if (!result.valid) {
        const status = result.reason === "budget_exceeded" ? 429 : 401;
        return res.status(status).json({ error: result.reason });
      }

      if (scope && !ak.hasScope(result, scope)) {
        return res.status(403).json({
          error: "insufficient_scope",
          required: scope,
          available: result.scopes,
        });
      }

      req.m2m = verified;
      req.agentKey = result;
      next();
    } catch (err) {
      // clerkClient.m2m.verify() and the agentkey DB lookups reject on routine
      // faults (network, pool exhaustion, statement timeout). Express 4 does not
      // forward a rejected promise from async middleware, so without this the
      // request hangs. Fail closed with a 500.
      console.error("clerkAgentKeyMiddleware error:", err);
      return res.status(500).json({ error: "auth_unavailable" });
    }
  };
}

// Charge a machine's budget after its billable work (e.g. after an LLM call).
// Thin wrapper over agentkey's subject-keyed usage tracking.
export function trackByM2M(
  ak: AgentKey,
  subject: string,
  costCents: number,
) {
  return ak.trackUsageBySubject(subject, { costCents });
}
