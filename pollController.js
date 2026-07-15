// pollController.js — desired-state, latest-wins owner of the executor's continuous polling.
//
// Iteration 1 (Phase 1.2). Replaces the command-style start/stop/reconfigure API — which could not
// serialize concurrent commands (the confirmed A/B/C race) — with ONE desired-state reconciler:
//
//   setDesired({controlUrl})  → "I should be polling this URL"
//   setDesired(null)          → "I should not be polling"
//
// A single serialized reconcile pump brings the actual run into line with the LATEST desired value,
// coalescing bursts (A→B→C reconciles once, to C). Invariants:
//   1. at most one active poll run exists at any instant;
//   2. the latest desired always wins; a superseded desired never produces a poll;
//   3. a stale generation can neither poll nor clear the current run (generation guard);
//   4. a poll-loop exception can never leave a stuck run (try/catch/finally); recovery is driven by
//      the coordinator's alarm calling setDesired again — the loop does not self-relaunch (no spin).
//
// Recovery latency after a self-death is therefore bounded by the recovery alarm (≤30s), by design.
// The transport MUST honor the {signal} so setDesired(null) / reconfigure aborts a long poll promptly.
//
// Out of scope (Iteration 2): task-phase recovery, durable idempotency — those are core-owned.

const NOOP_LOGGER = { debug() {}, info() {}, warn() {}, error() {} };
const NOOP_EXIT_SINK = () => {};
const MAX_ERROR_LEN = 300;
const POLL_ERROR_CATEGORIES = new Set(['auth', 'http', 'network', 'protocol', 'dispatch']);

function boundedError(message) {
    if (typeof message !== 'string') { return null; }
    return message.length > MAX_ERROR_LEN ? message.slice(0, MAX_ERROR_LEN) + '…' : message;
}

function safeErrorCategory(error) {
    return POLL_ERROR_CATEGORIES.has(error?.pollCategory) ? error.pollCategory : 'runtime';
}

export class PollController {
    // deps:
    //   pollOnce(controlUrl, { signal }): Promise<boolean> — one poll; true=continue, false=stop.
    //       MUST honor `signal` so stop/reconfigure aborts a held poll without waiting it out.
    //   logger, onExit(event) (optional observability port), delayMs (inter-poll gap).
    constructor({ pollOnce, logger, onExit = NOOP_EXIT_SINK, delayMs = 100 } = {}) {
        if (typeof pollOnce !== 'function') {
            throw new Error('PollController requires a pollOnce(controlUrl, {signal}) function');
        }
        if (typeof onExit !== 'function') {
            throw new Error('PollController onExit must be a function');
        }
        this._pollOnce = pollOnce;
        this._logger = logger || NOOP_LOGGER;
        this._onExit = onExit;
        this._delayMs = delayMs;

        this._desired = null;        // { controlUrl } | null  — the latest desired configuration
        this._run = null;            // { generation, controlUrl, abort, stopping } | null
        this._generation = 0;
        this._reconciling = false;   // guards a single serialized reconcile pump
        this._settleWaiters = [];
    }

    isPolling() { return this._run !== null; }
    activeUrl() { return this._run ? this._run.controlUrl : null; }
    currentGeneration() { return this._run ? this._run.generation : 0; }

    // Latest-wins. Records desired and ensures the reconcile pump is running. Returns once the COMMAND
    // is accepted (pump kicked), NOT when the resulting poll loop ends — callers never await a loop.
    setDesired(config) {
        this._desired = config && config.controlUrl ? { controlUrl: config.controlUrl } : null;
        this._kickReconcile();
    }

    // Wait for the accepted desired state to become actual. This is deliberately separate from
    // setDesired(): event listeners stay non-blocking, while explicit stop/reset callers can prove
    // that the old held request was aborted and joined before replying to the user.
    whenSettled() {
        if (!this._reconciling && this._runMatchesDesired()) { return Promise.resolve(); }
        return new Promise((resolve) => this._settleWaiters.push(resolve));
    }

    _kickReconcile() {
        if (this._reconciling) { return; }          // a pump is already draining; it will see _desired
        this._reconciling = true;
        // Self-contained: the pump never rejects to callers.
        this._reconcileLoop().catch((err) => this._logger.error('reconcile pump threw', {
            error: boundedError(err && err.message),
        }));
    }

    async _reconcileLoop() {
        try {
            // Drain until the actual run matches the LATEST desired (which may change mid-drain).
            while (!this._runMatchesDesired()) {
                if (this._run) { await this._stopRun(); }   // abort+join the superseded run
                const desired = this._desired;               // re-read AFTER the join → latest wins
                if (desired) { this._launchRun(desired.controlUrl); }
                // if desired is null, the run is now null and the while condition exits
            }
        } finally {
            this._reconciling = false;
            // A setDesired that landed exactly as we cleared the flag must not be lost.
            if (!this._runMatchesDesired()) {
                this._kickReconcile();
            } else {
                this._resolveSettleWaiters();
            }
        }
    }

    _resolveSettleWaiters() {
        const waiters = this._settleWaiters.splice(0);
        for (const resolve of waiters) { resolve(); }
    }

    _runMatchesDesired() {
        const d = this._desired;
        if (!d) { return this._run === null; }
        return this._run !== null && this._run.controlUrl === d.controlUrl && !this._run.stopping;
    }

    _launchRun(controlUrl) {
        const generation = ++this._generation;
        const run = { generation, controlUrl, abort: new AbortController(), stopping: false, promise: null };
        this._run = run;
        run.promise = this._pollLoop(run);
        this._logger.info('poll run launched', { generation, controlUrl });
    }

    async _stopRun() {
        const run = this._run;
        if (!run) { return; }
        run.stopping = true;
        try { run.abort.abort(); } catch (_) { /* older runtimes */ }
        try { await run.promise; } catch (_) { /* _pollLoop never rejects; never let stop throw */ }
    }

    // Distinct external-interruption reason (matches the ADR): a stop (desired=null) vs a reconfigure
    // (desired changed to a new URL). Timeout is handled in the transport, never reaches here as abort.
    _stopReason() { return this._desired ? 'reconfigured' : 'stopped'; }

    async _pollLoop(run) {
        let exitReason = this._stopReason();
        let errorMessage = null;
        let errorCategory = null;
        try {
            while (this._run === run && !run.stopping) {
                let shouldContinue;
                try {
                    shouldContinue = await this._pollOnce(run.controlUrl, { signal: run.abort.signal });
                } catch (err) {
                    if (run.abort.signal.aborted || run.stopping) { exitReason = this._stopReason(); break; }
                    // The poison class: report and fall through to finally, which clears the run so the
                    // next alarm→setDesired can relaunch. The loop does NOT self-relaunch (no spin).
                    exitReason = 'exception';
                    errorMessage = boundedError(err && err.message);
                    errorCategory = safeErrorCategory(err);
                    this._logger.error('poll loop threw — clearing run so the alarm can recover', {
                        generation: run.generation, error: errorMessage, stack: err && err.stack,
                    });
                    break;
                }
                if (this._run !== run || run.stopping) {
                    exitReason = run.stopping ? this._stopReason() : 'superseded';
                    break;
                }
                if (!shouldContinue) { exitReason = 'poll_returned_false'; break; }
                await this._sleep(this._delayMs);
            }
        } finally {
            if (this._run === run) { this._run = null; }   // only the CURRENT run may clear the slot
            // Observability must NEVER gate control. The controller emits an immutable event in run-exit
            // order; Phase 1.4 owns bounded persistence. A sink may be slow, hung, or reject without
            // delaying stop/join/reconcile or allowing an old generation to overwrite current state.
            this._emitExit({
                generation: run.generation,
                reason: exitReason,
                error: errorMessage,
                errorCategory,
                at: new Date().toISOString(),
            });
        }
    }

    _sleep(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }

    _emitExit(event) {
        let pending;
        try {
            pending = this._onExit(Object.freeze(event));
        } catch (e) {
            this._warnExitSink(e);
            return;
        }
        Promise.resolve(pending).catch((e) => this._warnExitSink(e));
    }

    _warnExitSink(error) {
        try {
            this._logger.warn('poll exit sink failed', { error: boundedError(error && error.message) });
        } catch (_) { /* observability failures remain isolated */ }
    }
}
