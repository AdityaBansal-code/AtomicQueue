# AtomicQueue

A multi-tenant appointment booking platform. Customers pick a time slot on a business's public page and confirm it without creating an account. The backend is designed so that two people cannot end up holding or booking the same slot at the same time.

**Live:** https://atomic-queue-web.vercel.app

![TypeScript](https://img.shields.io/badge/TypeScript-5.x-blue.svg)
![Node.js](https://img.shields.io/badge/Node.js-20%2B-green.svg)
![Turborepo](https://img.shields.io/badge/Turborepo-2.x-red.svg)

## Contents

- [Features](#features)
- [How double-booking is prevented](#how-double-booking-is-prevented)
- [Architecture](#architecture)
- [Tech stack](#tech-stack)
- [Project structure](#project-structure)
- [Getting started](#getting-started)
- [Testing](#testing)
- [Deployment](#deployment)
- [Known limitations](#known-limitations)
- [License](#license)

## Features

- **Public booking page per business:** customers view live availability, hold a slot and confirm it with a short form.
- **Slot holds:** choosing a slot places a five-minute hold; the hold must still be valid when the booking is confirmed.
- **Reschedule and cancel** flows for confirmed bookings.
- **Waitlist:** customers can join a waitlist for a full slot. When a slot is released, the earliest waiting entry (first come, first served) is notified and the slot is reserved for them.
- **Real-time availability:** slot changes are pushed to connected clients over Socket.IO, scoped to the business being viewed.
- **Multi-tenant model:** each business owns its services, providers, resources, availability and slots. Staff accounts have a separate, more limited role from owners.
- **Background jobs (BullMQ):** weekly slot generation, expiry of stale holds, reminder and notification emails, optional no-show scoring.
- **Optional AI no-show risk note:** if a Gemini API key is configured, a background job adds a risk note to bookings. With no key it does nothing.
- **Email through Resend**, or logged to the console when no key is configured.

## How double-booking is prevented

MongoDB is the source of truth for slots, holds and bookings. Redis is not used to decide who holds a slot.

1. **One atomic claim.** Taking a hold is a single conditional update: it moves a slot from `available` to `held` only if it is still `available`, so concurrent requests for the same slot cannot both succeed. The loser receives a `409`.
2. **Capacity as unit documents.** A slot with capacity *N* is stored as *N* separate unit documents, so each claim still targets one document.
3. **Fencing token.** Each hold gets a fresh `holdVersion`, the owning session id and an expiry time. Confirming a booking must present the matching `holdVersion`; a late confirm on a slot that was released and re-claimed fails with `409 SLOT_HOLD_EXPIRED`.
4. **Transactions.** Claiming a hold and finalising a confirmation run inside MongoDB transactions, which is why the database must be a replica set.
5. **Database constraints.** Partial unique indexes enforce one active hold per session and one confirmed booking per slot.
6. **Side effects after commit.** Realtime events, emails and background-job enqueues happen after the transaction commits, so a failure there does not undo a confirmed booking.
7. **Expiry.** Abandoned holds are released lazily when a slot is contended and by a background job that sweeps expired holds every minute.

Redis is used for: login/magic-link rate limiting (atomic Lua `INCR` + `EXPIRE`), sessions, a short-lived cache, and the BullMQ queues.

## Architecture

```text
Browser (React)  <--- HTTP + Socket.IO --->  Express API (apps/api)
                                                |         |
                                                |         +--> Redis: sessions, rate limits, cache, BullMQ queues
                                                v
                                             MongoDB (replica set): slots, bookings, tenants, waitlist
                                                ^
                         BullMQ worker (same codebase, separate process): slot generation, hold expiry, emails, no-show scoring
```

## Tech stack

| Layer | Technology |
| :--- | :--- |
| Frontend | React 19, TypeScript, Vite, Tailwind CSS, shadcn/ui components |
| API | Node.js, Express 4, TypeScript, Zod validation |
| Database | MongoDB with Mongoose (transactions require a replica set) |
| Sessions, rate limiting, queues | Redis (e.g. Upstash), BullMQ |
| Real time | Socket.IO |
| Email | Resend (optional) |
| AI (optional) | Google Gemini, default model `gemini-1.5-flash` |
| Monorepo | npm workspaces and Turborepo |

## Project structure

```text
apps/
  api/            Express API, Socket.IO server and the BullMQ worker (src/server.ts, src/worker.ts)
  web/            React + Vite frontend
packages/
  shared-types/   TypeScript types shared by API and web
scripts/          Concurrency demo, smoke tests and other utility scripts
.env.example      Environment variable template (copy to apps/api/.env)
```

## Getting started

### Prerequisites

- Node.js 20 or newer (the CI workflow runs Node 24)
- A MongoDB **replica set** (MongoDB Atlas works; a standalone server does not support transactions)
- A Redis instance (local, Docker, or an Upstash `rediss://` URL)

### Install and configure

```bash
git clone https://github.com/AdityaBansal-code/AtomicQueue.git
cd AtomicQueue
npm install
cp .env.example apps/api/.env
```

Edit `apps/api/.env`. The required values are `MONGODB_URI`, `REDIS_URL` and `SESSION_COOKIE_SECRET`. `GEMINI_API_KEY`, `RESEND_API_KEY` and `RESEND_FROM_EMAIL` are optional in development. In production, startup fails if the session secret is left at the placeholder, or if the Resend variables are missing.

### Run locally

```bash
npm run dev
```

This starts the API (default port 4000) and the Vite dev server at http://localhost:5173, which proxies `/api` to the API. To run pieces separately:

```bash
npm run dev --workspace=@queueless/api      # API only
npm run dev --workspace=web                 # frontend only
npm run worker --workspace=@queueless/api   # BullMQ worker
```

## Testing

- **Integration tests:** `apps/api/src/integration.spec.ts` covers cross-user slot contention, same-session contention, double confirmation and auth rate limiting. It uses Node's test runner and needs a MongoDB replica set and Redis.
- **Concurrency demo:** `scripts/concurrency-demo.mjs [baseUrl] [racers]` fires simultaneous hold requests at one slot and checks that only the available capacity succeeds (the rest get `409 SLOT_NOT_AVAILABLE`). It needs a running API.

  ```bash
  node scripts/concurrency-demo.mjs                        # http://localhost:4000, 8 racers
  node scripts/concurrency-demo.mjs https://your-deployment 12
  ```
- **Other scripts** in `scripts/` cover hold expiry, session holds, waitlist behaviour and a production smoke test.
- **CI** (`.github/workflows/ci.yml`) runs `npm ci`, lint and build. It does not run the integration tests or the scripts above.

## Deployment

Production is single-origin: build the frontend and the API serves `apps/web/dist` itself, so no CORS configuration is needed.

```bash
npm run build
npm run start --workspace=@queueless/api   # starts the worker and the server
```

Use a replica-set MongoDB URI and a TLS Redis URL, set a strong `SESSION_COOKIE_SECRET`, and set `FRONTEND_URL` to the deployed origin so links in emails resolve. See the production checklist at the top of `.env.example`.

## Known limitations

- **No transactional outbox.** Realtime events, emails and queue jobs are sent after the booking transaction commits. If enqueueing a job fails, the failure is logged but not retried, so a confirmed booking can occasionally miss its follow-up job or email. A transactional outbox would close this gap and is not implemented.
- **Tests are not run automatically.** CI covers lint and build only; the integration tests and concurrency scripts must be run manually against real MongoDB and Redis.
- **Expiry delay.** An expired hold on a slot nobody else tries to claim can still show as held for up to about a minute, until the next expiry sweep.
- **Optional features** (Gemini no-show notes, Resend email) do nothing unless configured.
- **Stale comment:** the `REDIS_URL` comment in `.env.example` still mentions "booking holds". Holds live in MongoDB; Redis is not used for them.

## License

No license file is currently included in this repository.
