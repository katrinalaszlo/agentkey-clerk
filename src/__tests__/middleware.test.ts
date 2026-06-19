import { describe, it, expect, beforeAll, afterAll } from "vitest";
import express from "express";
import type { Server } from "http";
import type {
  AgentKey,
  ValidateResult,
  ValidateFailure,
  TrackUsageResult,
  EnsureSubjectOptions,
} from "@katrinalaszlo/agentkey";
import {
  clerkAgentKeyMiddleware,
  trackByM2M,
  type VerifiedM2MToken,
  type ClerkM2MClient,
} from "../index.js";

// In-memory stand-in for AgentKey's subject-keyed surface. The real budget/SQL
// behavior is covered by agentkey's own suite; here we only exercise the
// middleware's orchestration (provision-on-first-seen, status mapping, scope
// gate, fail-closed), so a fake keeps these tests DB-free and CI-safe.
class FakeAk {
  rows = new Map<
    string,
    { scopes: string[] | null; budgetCents: number | null; used: number }
  >();

  seed(
    subject: string,
    row: { scopes?: string[] | null; budgetCents?: number | null; used?: number },
  ) {
    this.rows.set(subject, {
      scopes: row.scopes ?? null,
      budgetCents: row.budgetCents ?? null,
      used: row.used ?? 0,
    });
  }

  async ensureSubject(subject: string, opts: EnsureSubjectOptions = {}) {
    if (!this.rows.has(subject)) {
      this.rows.set(subject, {
        scopes: opts.scopes ?? null,
        budgetCents: opts.budgetCents ?? null,
        used: 0,
      });
    }
  }

  async validateBySubject(
    subject: string,
  ): Promise<ValidateResult | ValidateFailure> {
    const r = this.rows.get(subject);
    if (!r) return { valid: false, reason: "invalid" };
    if (r.budgetCents != null && r.used >= r.budgetCents) {
      return { valid: false, reason: "budget_exceeded" };
    }
    return {
      valid: true,
      id: 1,
      accountId: subject,
      userId: null,
      scopes: r.scopes,
      budgetCents: r.budgetCents,
      budgetUsedCents: r.used,
      budgetRemainingCents: r.budgetCents == null ? null : r.budgetCents - r.used,
      budgetPeriod: null,
      budgetResetAt: null,
      expiresAt: null,
      delegatedBy: null,
      name: "default",
    };
  }

  async trackUsageBySubject(
    subject: string,
    opts: { costCents: number },
  ): Promise<TrackUsageResult> {
    const r = this.rows.get(subject);
    if (!r) return { success: false, reason: "invalid_key" };
    if (r.budgetCents != null && r.used + opts.costCents > r.budgetCents) {
      return { success: false, reason: "budget_exceeded" };
    }
    r.used += opts.costCents;
    return {
      success: true,
      budgetUsedCents: r.used,
      budgetRemainingCents: r.budgetCents == null ? null : r.budgetCents - r.used,
    };
  }

  hasScope(result: ValidateResult, scope: string): boolean {
    if (result.scopes === null) return true;
    return result.scopes.includes(scope) || result.scopes.includes("admin");
  }
}

function mockClerk(
  resolve: VerifiedM2MToken | (() => Promise<VerifiedM2MToken>),
): ClerkM2MClient {
  return {
    m2m: {
      verify: typeof resolve === "function"
        ? resolve
        : async () => resolve,
    },
  };
}

function token(overrides: Partial<VerifiedM2MToken> = {}): VerifiedM2MToken {
  return { id: "m2m_1", subject: "mach_1", ...overrides };
}

describe("clerkAgentKeyMiddleware", () => {
  let server: Server;
  let base: string;
  let fake: FakeAk;
  let clerk: ClerkM2MClient;
  let verifyImpl: () => Promise<VerifiedM2MToken>;

  beforeAll(() => {
    fake = new FakeAk();
    fake.seed("mach_known", { scopes: ["read"], budgetCents: 100 });
    fake.seed("mach_broke", { scopes: ["read"], budgetCents: 50, used: 50 });

    // Indirection so each test can set the verify() behavior.
    verifyImpl = async () => token({ subject: "mach_known" });
    clerk = mockClerk(() => verifyImpl());

    const app = express();
    app.get(
      "/agent",
      clerkAgentKeyMiddleware({
        clerkClient: clerk,
        ak: fake as unknown as AgentKey,
        defaults: { scopes: ["read"], budgetCents: 500, budgetPeriod: "month" },
        scope: "read",
      }),
      (req, res) => res.json({ ok: true, subject: req.agentKey?.accountId }),
    );

    server = app.listen(0);
    const addr = server.address();
    const port = typeof addr === "object" && addr ? addr.port : 0;
    base = `http://localhost:${port}`;
  });

  afterAll(() => server.close());

  const call = (bearer?: string) =>
    fetch(`${base}/agent`, {
      headers: bearer ? { Authorization: `Bearer ${bearer}` } : {},
    });

  it("401s when the Bearer token is missing", async () => {
    const res = await call();
    expect(res.status).toBe(401);
  });

  it("passes a known, in-budget machine and attaches req.agentKey", async () => {
    verifyImpl = async () => token({ subject: "mach_known" });
    const res = await call("tok");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.subject).toBe("mach_known");
  });

  it("provisions a budget row the first time a machine is seen", async () => {
    verifyImpl = async () => token({ subject: "mach_fresh" });
    expect(fake.rows.has("mach_fresh")).toBe(false);
    const res = await call("tok");
    expect(res.status).toBe(200);
    expect(fake.rows.get("mach_fresh")?.budgetCents).toBe(500); // from defaults
  });

  it("429s when the machine is over budget", async () => {
    verifyImpl = async () => token({ subject: "mach_broke" });
    const res = await call("tok");
    expect(res.status).toBe(429);
    const body = await res.json();
    expect(body.error).toBe("budget_exceeded");
  });

  it("401s a revoked verified token", async () => {
    verifyImpl = async () => token({ subject: "mach_known", revoked: true });
    const res = await call("tok");
    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body.error).toBe("invalid_token");
  });

  it("401s an expired verified token", async () => {
    verifyImpl = async () => token({ subject: "mach_known", expired: true });
    const res = await call("tok");
    expect(res.status).toBe(401);
  });

  it("403s when the machine lacks the required scope", async () => {
    fake.seed("mach_noscope", { scopes: ["write"], budgetCents: 100 });
    verifyImpl = async () => token({ subject: "mach_noscope" });
    const res = await call("tok");
    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.error).toBe("insufficient_scope");
  });

  it("fails closed with 500 when verify throws", async () => {
    verifyImpl = async () => {
      throw new Error("clerk down");
    };
    const res = await call("tok");
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.error).toBe("auth_unavailable");
  });
});

describe("trackByM2M", () => {
  it("charges the machine's budget by subject", async () => {
    const fake = new FakeAk();
    fake.seed("mach_charge", { budgetCents: 100 });

    const r = await trackByM2M(fake as unknown as AgentKey, "mach_charge", 30);
    expect(r.success).toBe(true);
    expect(r.budgetRemainingCents).toBe(70);

    const over = await trackByM2M(fake as unknown as AgentKey, "mach_charge", 80);
    expect(over.success).toBe(false);
    expect(over.reason).toBe("budget_exceeded");
  });
});
