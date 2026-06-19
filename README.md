# agentkey-clerk

Spend caps for [Clerk](https://clerk.com) M2M tokens. Clerk authenticates your agent; agentkey-clerk caps what it can spend, scopes what it can do, and sets when its access ends.

## Why

Clerk's [machine-to-machine (M2M) tokens](https://clerk.com/docs/guides/development/machine-auth/m2m-tokens) authenticate your agents: which machine is calling, and which machines it may talk to. What they don't do is cap how much a machine can spend, meter its usage, or scope what it can do. So once your agent has a valid M2M token, nothing stops it from burning through a month of budget in twenty minutes.

This package adds that layer. The agent keeps carrying its Clerk M2M token. You add one middleware, and every request is checked against a per-machine budget, scope, and expiry before it runs.

| Layer | What it controls | Who covers it |
|---|---|---|
| Identity | Which machine is calling | **Clerk M2M** |
| Budget | How much this machine can spend | **agentkey** |
| Scope | What this machine can do | **agentkey** |
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
import { clerkAgentKeyMiddleware, trackByM2M } from "@katrinalaszlo/agentkey-clerk";

const pool = new pg.Pool();
const ak = new AgentKey({ pool });
await ak.migrate(); // adds the columns agentkey needs to your keys table

const clerkClient = createClerkClient({ secretKey: process.env.CLERK_SECRET_KEY });

const app = express();

app.use(
  "/api/agent",
  clerkAgentKeyMiddleware({
    clerkClient,
    ak,
    // Applied the first time each machine is seen.
    defaults: { scopes: ["proxy.chat"], budgetCents: 5000, budgetPeriod: "month" },
    scope: "proxy.chat", // optional: required capability for this route
  }),
);

// Inside a handler, after the agent's billable work:
app.post("/api/agent/chat", async (req, res) => {
  const cost = await callTheModel(req.body);
  await trackByM2M(ak, req.m2m!.subject, cost.cents);
  res.json(cost.result);
});
```

The agent calls your API with its Clerk M2M token in `Authorization: Bearer <token>`. The middleware:

1. verifies the token with Clerk (`clerkClient.m2m.verify`),
2. provisions a budget row for the machine on first sight (from `onFirstSeen` or `defaults`),
3. enforces budget, scope, and expiry,
4. attaches `req.m2m` (the verified token) and `req.agentKey` (the budget state).

## Responses

| Condition | Status |
|---|---|
| Valid, in budget, has scope | `next()` |
| Missing `Bearer` token | `401 Missing M2M token` |
| Revoked or expired Clerk token | `401 invalid_token` |
| Over budget | `429 budget_exceeded` |
| Missing required scope | `403 insufficient_scope` |
| Clerk or DB fault | `500 auth_unavailable` (fails closed) |

## Per-machine budgets

Pass `onFirstSeen` to set budget/scope from the verified token instead of a flat default:

```typescript
clerkAgentKeyMiddleware({
  clerkClient,
  ak,
  onFirstSeen: (token) => ({
    accountId: (token.claims?.org_id as string) ?? token.subject,
    scopes: ["proxy.chat"],
    budgetCents: 2000,
    budgetPeriod: "day",
    expiresIn: "30d",
  }),
});
```

`accountId` defaults to the machine subject if you don't set it.

## A note on scope

agentkey's `scopes` (what the agent may *do* — `proxy.chat`, `usage.read`) are not the same as Clerk's machine scopes (which machines may *talk to* which). This package enforces the agentkey kind. Set them in `defaults`/`onFirstSeen`.

## What it doesn't do

This is the per-machine spend layer only. It does not do hierarchical org > team > agent budget composition, and it does not put a human's Clerk session on the agent's request path (the agent carries its own M2M token — that's the point). For non-Clerk apps, use [`@katrinalaszlo/agentkey`](https://github.com/katrinalaszlo/agentkey) directly with its own `ak_` keys.

## License

MIT
