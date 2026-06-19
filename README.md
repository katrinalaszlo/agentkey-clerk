# agentkey-clerk

Spend caps for the [Clerk](https://clerk.com) API keys your users create. Your customers make API keys with Clerk; agentkey-clerk caps what each one can spend, scopes what it can do, and sets when its access ends.

![agentkey-clerk capping a customer's spend: a 30c/day cap at 10c per call, where the 4th request is blocked with a 429](assets/demo.gif)

## Why

When you give your customers [API keys](https://clerk.com/docs/guides/development/machine-auth/api-keys) through Clerk, each key calls your API on that customer's behalf. Clerk issues, verifies, and revokes the key. What it doesn't do is cap how much a customer's key can spend against your paid API, so one customer's runaway script can burn through usage that affects everyone else.

agentkey-clerk adds that layer. The customer keeps using their Clerk-issued key. You add one middleware, and every request is checked against a per-customer budget, scope, and expiry before it runs. It caps **dollars** (not just request counts) and blocks the call the moment a key crosses its budget.

> agentkey-clerk is an independent, open-source companion to Clerk. It is not affiliated with Clerk.

| Layer | What it controls | Who covers it |
|---|---|---|
| Identity | Which customer's key is calling | **Clerk API Keys** |
| Budget | How much this key can spend (in dollars) | **agentkey** |
| Scope | What this key can do | **agentkey** |
| Expiry | When access ends | **agentkey** |

Built on [`@katrinalaszlo/agentkey`](https://github.com/katrinalaszlo/agentkey).

## Install

```bash
npm install @katrinalaszlo/agentkey-clerk @katrinalaszlo/agentkey
```

You bring your own Clerk client (`@clerk/backend` or `@clerk/express`) and a Postgres pool — this package doesn't wrap either.

## Quick start

```typescript
import express from "express";
import pg from "pg";
import { createClerkClient } from "@clerk/backend";
import { AgentKey } from "@katrinalaszlo/agentkey";
import { clerkApiKeyMiddleware, trackByApiKey } from "@katrinalaszlo/agentkey-clerk";

const pool = new pg.Pool();
const ak = new AgentKey({ pool });
await ak.migrate(); // adds the columns agentkey needs to your keys table

const clerkClient = createClerkClient({ secretKey: process.env.CLERK_SECRET_KEY });

const app = express();

app.use(
  "/api",
  clerkApiKeyMiddleware({
    clerkClient,
    ak,
    // Applied the first time each customer's key is seen.
    defaults: { budgetCents: 5000, budgetPeriod: "month" },
  }),
);

// Inside a handler, after the customer's billable work:
app.post("/api/chat", async (req, res) => {
  const cost = await callTheModel(req.body);
  await trackByApiKey(ak, req.clerkApiKey!.subject, cost.cents);
  res.json(cost.result);
});
```

The customer calls your API with their Clerk API key in `Authorization: Bearer <key>`. The middleware:

1. verifies the key with Clerk (`clerkClient.apiKeys.verify`),
2. provisions a budget row for the customer — the key's `subject`, a `user_` or `org_` id — on first sight,
3. enforces budget, scope, and expiry,
4. attaches `req.clerkApiKey` (the verified key) and `req.agentKey` (the budget state).

## Responses

| Condition | Status |
|---|---|
| Valid, in budget, has scope | `next()` |
| Missing `Bearer` key | `401 Missing API key` |
| Invalid / revoked / expired key | `401 invalid_key` |
| Over budget | `429 budget_exceeded` |
| Missing required scope | `403 insufficient_scope` |
| DB fault | `500 auth_unavailable` (fails closed) |

## Per-customer budgets

Pass `onFirstSeen` to set budget/scope from the verified key — for example, read a plan tier off the key's `claims`:

```typescript
clerkApiKeyMiddleware({
  clerkClient,
  ak,
  onFirstSeen: (apiKey) => ({
    accountId: apiKey.subject, // user_xxx or org_xxx
    scopes: ["proxy.chat"],
    budgetCents: apiKey.claims?.tier === "pro" ? 20000 : 2000,
    budgetPeriod: "month",
    expiresIn: "30d",
  }),
});
```

`accountId` defaults to the key's `subject` if you don't set it.

## A note on scope

agentkey's `scopes` (what a key may *do* — `proxy.chat`, `usage.read`) are enforced by this package against the budget row. They're separate from Clerk's own API-key scopes. Set them in `defaults`/`onFirstSeen`.

## Also: internal services (Clerk M2M)

If you also want to cap your *own* backend services (microservices, workers) that authenticate with [Clerk M2M tokens](https://clerk.com/docs/guides/development/machine-auth/m2m-tokens) — which are distinct from customer API keys — use `clerkAgentKeyMiddleware` + `trackByM2M`. Same shape, keyed on the M2M machine subject. That's internal cost control rather than customer spend caps.

## What it doesn't do

Per-key dollar spend caps only. No hierarchical org > team > key budget composition. For non-Clerk apps, use [`@katrinalaszlo/agentkey`](https://github.com/katrinalaszlo/agentkey) directly with its own `ak_` keys.

## License

MIT
