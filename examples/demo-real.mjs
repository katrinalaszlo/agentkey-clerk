// REAL Clerk demo: verifies an actual Clerk API key over the network.
// This is the end-to-end test. If a real key gets capped here, it works.
//
//   1. Create a Clerk app (free) and enable API Keys.
//   2. Mint one API key (Clerk dashboard, or the <UserProfile /> component).
//   3. export CLERK_SECRET_KEY=sk_test_...        (your Clerk secret key)
//   4. export DATABASE_URL=postgres://postgres:postgres@localhost:5435/postgres
//   5. node examples/demo-real.mjs
//   6. curl -H "Authorization: Bearer <your_clerk_api_key>" http://localhost:3000/api
//
// 30c/day cap, 10c per call -> first 3 calls return 200, the 4th returns 429.

import express from "express";
import pg from "pg";
import { createClerkClient } from "@clerk/backend";
import { AgentKey } from "@katrinalaszlo/agentkey";
import { clerkApiKeyMiddleware, trackByApiKey } from "../dist/index.js";

if (!process.env.CLERK_SECRET_KEY) {
  console.error("Set CLERK_SECRET_KEY first (your Clerk secret key, starts with sk_).");
  process.exit(1);
}

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
const ak = new AgentKey({ pool });

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

// The real thing: Clerk verifies the key over the network and returns the customer.
const clerkClient = createClerkClient({ secretKey: process.env.CLERK_SECRET_KEY });

const app = express();

app.get(
  "/api",
  clerkApiKeyMiddleware({
    clerkClient,
    ak,
    defaults: { budgetCents: 30, budgetPeriod: "day" }, // $0.30/day cap
  }),
  async (req, res) => {
    const charge = await trackByApiKey(ak, req.clerkApiKey.subject, 10); // 10c per call
    res.json({
      ok: true,
      customer: req.clerkApiKey.subject,
      usedCents: charge.budgetUsedCents,
      remainingCents: charge.budgetRemainingCents,
    });
  },
);

app.listen(3000, () =>
  console.log("listening on http://localhost:3000/api  — call it with your real Clerk API key"),
);
