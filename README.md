# AtomicQueue

## Project Overview
AtomicQueue is a production-grade, multi-tenant appointment booking platform that guarantees **no double-booking** even under heavy concurrent load. It provides secure authentication, tenant management, scheduling, wait-listing, and real-time UI updates, all powered by a modern TypeScript monorepo.

## Features
- Atomic booking flow with transactional holds, confirmations, reschedules and cancellations.
- Real-time slot updates via Socket.IO.
- Rate-limited authentication and secure session management with Redis.
- Optional AI-assisted no-show scoring (Google Gemini).
- Scalable monorepo using Turborepo; shared types between API and web.

## Tech Stack
| Layer | Technology |
|---|---|
| Frontend | React 19 + TypeScript + Vite |
| Backend | Node.js + Express 4 + TypeScript |
| Database | MongoDB (transactions) |
| Cache / Sessions | Redis (Upstash) |
| Jobs | BullMQ |
| Realtime | Socket.IO |
| Optional AI | Google Gemini |
| Email | Resend |
| Validation | Zod |
| Monorepo tooling | Turborepo |

## Prerequisites
- Node.js = 20 (npm 11.x)
- MongoDB replica-set (MongoDB Atlas recommended)
- Redis instance (
ediss:// URL)

## Setup
`ash
git clone https://github.com/AdityaBansal-code/AtomicQueue.git
cd AtomicQueue
npm install               # install all workspaces
cp .env.example apps/api/.env   # configure environment variables
# edit .env with MONGODB_URI, REDIS_URL, SESSION_COOKIE_SECRET, etc.
`
.env is git-ignored � never commit real credentials.

## Running Locally
`ash
npm run dev                # start API, Web and Worker concurrently
# or start individual components
npm run dev --workspace=@queueless/api   # API only
npm run dev --workspace=web              # Frontend only
npm run worker --workspace=@queueless/api # BullMQ worker
`
Visit the frontend at http://localhost:5173.

## Testing Concurrency
`ash
node scripts/concurrency-demo.mjs               # against local dev
node scripts/concurrency-demo.mjs https://your-deploy   # against deployed instance
`
The demo asserts that exactly one request succeeds per slot.

## Deployment
`ash
npm run build               # builds API and Web assets
npm run start --workspace=@queueless/api   # serve built assets
`
The API serves the built frontend, providing a single-origin production deployment (no CORS needed).

## Contributing
1. Fork the repository and create a feature branch.
2. Follow the existing code style (TypeScript, ESLint, Prettier).
3. Write tests for new functionality.
4. Open a pull request with a clear description.

## License
MIT License � see [LICENSE](./LICENSE).

## Roadmap
- Phase?6: Multi-provider matching & advanced wait-list heuristics
- Phase?7: Public OpenAPI spec and SDKs
- Phase?8: Full CI/CD pipeline with automated rollout



This is just a testing for checking something regarding github project
