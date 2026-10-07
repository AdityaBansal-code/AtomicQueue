# AtomicQueue ⚛️

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](./LICENSE)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.x-blue.svg)](https://www.typescriptlang.org/)
[![Node.js](https://img.shields.io/badge/Node.js-20.x-green.svg)](https://nodejs.org/)
[![Turborepo](https://img.shields.io/badge/Turborepo-2.x-red.svg)](https://turbo.build/)

> A production-grade, multi-tenant appointment booking platform built to guarantee **zero double-bookings** even under extreme concurrent load.

AtomicQueue is engineered for reliability and speed. It provides secure authentication, comprehensive tenant (business) management, robust scheduling, wait-listing, and real-time UI updates, all architected within a modern, highly scalable TypeScript monorepo.

---

## ✨ Key Features

- **Strictly Atomic Bookings:** Rock-solid booking flow with transactional holds, confirmations, reschedules, and cancellations. Zero race conditions.
- **Real-Time Synchronization:** Instantaneous slot availability updates across all connected clients via Socket.IO.
- **Multi-Tenant Architecture:** Secure isolation for multiple businesses, providers, and staff under a single deployment.
- **Advanced Waitlist Engine:** Automated FIFO waitlist processing and notifications when slots open up.
- **Smart AI Integration:** Optional AI-assisted no-show risk scoring powered by Google Gemini.
- **Robust Security:** Rate-limited authentication, secure Redis-backed session management, and strict role-based access control (RBAC).
- **Modern Monorepo:** Managed with Turborepo for lightning-fast builds and seamless code sharing (types, configurations) between API and Web clients.

## 🛠️ Technology Stack

| Layer | Technology |
| :--- | :--- |
| **Frontend** | React 19, TypeScript, Vite, Tailwind CSS, shadcn/ui |
| **Backend API** | Node.js, Express 4, TypeScript |
| **Database** | MongoDB (Strictly utilizing Transactions) |
| **Cache & Sessions** | Redis (Upstash) |
| **Background Jobs** | BullMQ |
| **Real-Time** | Socket.IO |
| **AI (Optional)** | Google Gemini (1.5 Flash) |
| **Email Delivery** | Resend |
| **Validation** | Zod |
| **Monorepo Tooling**| Turborepo |

## 📂 Project Structure

This project is a monorepo utilizing [Turborepo](https://turbo.build/).

```text
AtomicQueue/
├── apps/
│   ├── api/          # Express backend API & Socket.IO server
│   └── web/          # React Vite frontend application
├── packages/
│   └── shared-types/ # Shared TypeScript interfaces and domain types
└── scripts/          # Utility scripts (e.g., concurrency testing)
```

## 🚀 Getting Started

### Prerequisites

Ensure you have the following installed and running:
- **Node.js** = `v20.x` (npm `11.x`)
- **MongoDB** replica-set (Required for transactions. MongoDB Atlas is highly recommended)
- **Redis** instance (e.g., local, Docker, or Upstash `rediss://` URL)

### Installation

1. **Clone the repository:**
   ```bash
   git clone https://github.com/AdityaBansal-code/AtomicQueue.git
   cd AtomicQueue
   ```

2. **Install dependencies:**
   ```bash
   npm install
   ```

3. **Configure Environment Variables:**
   ```bash
   cp apps/api/.env.example apps/api/.env
   ```
   *Edit `apps/api/.env` with your `MONGODB_URI`, `REDIS_URL`, `SESSION_COOKIE_SECRET`, and optionally `GEMINI_API_KEY` and `RESEND_API_KEY`.*

### Running Locally

Start the entire stack (API, Web Frontend, and Background Worker) concurrently:

```bash
npm run dev
```

The frontend will be available at [http://localhost:5173](http://localhost:5173).

**Running specific workspaces:**
```bash
npm run dev --workspace=@queueless/api    # Start API only
npm run dev --workspace=web               # Start Frontend only
npm run worker --workspace=@queueless/api # Start BullMQ background worker
```

## 🧪 Testing Concurrency

AtomicQueue's core feature is its ability to handle concurrent booking attempts flawlessly. You can test this using the included concurrency script:

```bash
# Test against a local development instance
node scripts/concurrency-demo.mjs

# Test against a deployed production instance
node scripts/concurrency-demo.mjs https://your-deployed-app.com
```
*This demo hits the hold/confirm endpoints concurrently and asserts that exactly one request succeeds per available slot capacity, gracefully handling the rest.*

## 📦 Deployment

The application is designed for a single-origin production deployment, meaning the API serves the built frontend assets (no CORS required).

```bash
# Build API and Web assets
npm run build

# Start the production server
npm run start --workspace=@queueless/api
```

## 🤝 Contributing

We welcome contributions! Please follow these steps:
1. Fork the repository and create a feature branch (`git checkout -b feature/amazing-feature`).
2. Adhere to the existing code style (TypeScript, ESLint, Prettier).
3. Ensure you write tests for new functionality, particularly concurrency-sensitive paths.
4. Open a Pull Request with a clear, detailed description of your changes.

## 🗺️ Roadmap

- **Phase 6:** Multi-provider matching & advanced wait-list heuristics.
- **Phase 7:** Public OpenAPI specification and client SDKs.
- **Phase 8:** Full CI/CD pipeline with automated rollouts.

## 📄 License

This project is licensed under the MIT License - see the [LICENSE](./LICENSE) file for details.
