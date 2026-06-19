// Runnable demo: watch agentkey-clerk cap a customer's spend.
//
// Clerk is STUBBED here (verify() returns a fixed demo customer) so you don't
// need a Clerk account to see the enforcement loop. Swap the stub for a real
// `createClerkClient({ secretKey })` and it works against real Clerk API keys.
//
//   DATABASE_URL=postgres://postgres:postgres@localhost:5434/postgres node examples/demo.mjs
//
// Then: curl -H "Authorization: Bearer anything" localhost:3000/api
// 30c/day cap, 10c per call -> 3 calls pass, the 4th gets 429.

import express from "express";
import pg from "pg";
import { AgentKey } from "@katrinalaszlo/agentkey";
import { clerkApiKeyMiddleware, trackByApiKey } from "../dist/index.js";

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
const ak = new AgentKey({ pool });

// A base keys table + agentkey's columns (adds external_subject).
await pool.query(`
  CREATE TABLE IF NOT EXISTS sdk_api_keys (
    id SERIAL PRIMARY KEY,
    account_id TEXT,
    key_hash TEXT NOT NULL UNIQUE,
    key_prefix TEXT NOT NULL,
    name TEXT NOT NULL DEFAULT 'default',
    created_at TIMESTAMPTZ DEFAULT NOW(),
    last_used_at TIMESTAMPTZ,
    revoked_at TIMESTAMPTZ
  )
`);
await ak.migrate();

// Stub Clerk: any key verifies to the same demo customer.
const clerkClient = {
  apiKeys: {
    verify: async (_secret) => ({ id: "ak_demo", subject: "user_demo", scopes: ["read"] }),
  },
};

const app = express();

app.get(
  "/api",
  clerkApiKeyMiddleware({
    clerkClient,
    ak,
    // First time we see this customer: $0.30/day cap.
    defaults: { scopes: ["read"], budgetCents: 30, budgetPeriod: "day" },
    scope: "read",
  }),
  async (req, res) => {
    // The "billable work" cost 10 cents this call.
    const charge = await trackByApiKey(ak, req.clerkApiKey.subject, 10);
    res.json({
      ok: true,
      customer: req.clerkApiKey.subject,
      usedCents: charge.budgetUsedCents,
      remainingCents: charge.budgetRemainingCents,
    });
  },
);

app.listen(3000, () => console.log("listening on http://localhost:3000/api"));
