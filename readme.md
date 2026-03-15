# Practice 3: API Orchestration & Service Composition

**Course:** Enterprise Application Integration (EAI)  
**Status:** Completed & Auto-Graded (10/10 Tests Passing)

## 1. Objective
This project implements a Node.js orchestration service that exposes a `POST /checkout` endpoint. It performs a distributed business transaction across four downstream APIs (Payment, Inventory, Shipping, Notification) using the **Synchronous Saga Pattern**. The orchestrator guarantees strict execution order, gracefully handles timeouts, executes reverse-order compensations upon failure, and maintains deterministic idempotency with restart-safe persistence.

---

## 2. Architecture Rationale

The implementation resides in `server.js` and follows a strict synchronous orchestrator pattern. 

### Strict Sequence Enforcement
The orchestration executes sequentially: `Payment -> Inventory -> Shipping -> Notification`. 
Parallel downstream invocations are intentionally avoided to ensure a strict dependency chain. If a step fails, execution halts immediately and shifts to the compensation phase.

### Compensation Strategy
If a downstream service fails or times out, a reverse-order rollback is triggered to maintain data consistency across the distributed system:
* **Inventory failure:** Refund payment.
* **Shipping failure/timeout:** Release inventory, then refund payment.
* **Notification failure/timeout:** Release inventory, then refund payment (per business rules).
* **Compensation Failure:** If any rollback step fails, the orchestrator halts and returns an HTTP `422` with `code: compensation_failed`.

### Timeout Behavior
Every downstream call is wrapped in a timeout handler governed by `REQUEST_TIMEOUT_MS`. Axios errors with code `ECONNABORTED` are caught, mapped to a `timeout` status in the trace log, and returned to the client as an HTTP `504 Gateway Timeout`.

### Deterministic Idempotency
The orchestrator strictly enforces the `Idempotency-Key` header:
* **Same key + same payload (terminal):** Replays the stored HTTP status and response body without hitting downstream APIs.
* **Same key + same payload (in-progress):** Rejects the request with HTTP `409` and `code: idempotency_conflict`.
* **Same key + different payload:** Rejects the request with HTTP `409` and `code: idempotency_payload_mismatch`.

### Restart-Safe Persistence
State is synchronously written to local file storage (`/data/idempotency-store.json` and `/data/saga-store.json`) at every state change. Because writes are atomic and happen before the HTTP response is sent, the orchestrator can perfectly recover and replay idempotent requests even if the Docker container is completely restarted.

### Trace Contract
Every execution step (both forward flow and compensation) is appended to a `trace` array. Each record captures the `step` name, `status`, `startedAt`, `finishedAt`, and precisely calculated `durationMs`. This array is stored under the `steps` key in the persistence layer to satisfy strict schema validation.

---

## 3. How to Run Locally

**Prerequisites:** Docker Desktop and Node.js 18+

### Start the Environment
```bash
# Build and run the orchestrator and mock downstream services
docker compose up -d --build