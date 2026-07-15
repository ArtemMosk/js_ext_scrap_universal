// pollTransport.js — one authenticated /get_url operation. ONE responsibility: perform a single poll
// request, honor an external abort signal AND an internal timeout with DISTINCT reasons, decode one
// response. It owns request-timeout mechanics, not lifecycle policy (that is pollController's job).
//
// Distinct abort reasons matter: an external abort (operator stop / reconfigure) must not be misread
// as a timeout (which triggers an immediate replacement poll). The thrown AbortError carries
// `.reason` = 'external' | 'timeout'.
//
// Timing (user-approved 2026-07-14): the server holds ~20-25s (inside Chrome's documented ~30s
// fetch-response boundary); the client timeout is the hold + a small margin, set by the caller.

export const POLL_RESULT = Object.freeze({ EMPTY: 'empty', PAYLOAD: 'payload' });
export const POLL_REQUEST_TIMEOUT_MS = 27_000;

export function withPollCategory(error, pollCategory) {
    const source = error instanceof Error ? error : new Error(String(error));
    try {
        Object.defineProperty(source, 'pollCategory', {
            value: pollCategory,
            configurable: true,
        });
        return source;
    } catch (_) {
        const wrapped = new Error(source.message);
        wrapped.pollCategory = pollCategory;
        return wrapped;
    }
}

// deps:
//   signal       — external AbortSignal (from the poll run); optional.
//   authHeaders  — async () => headers; injected (prod: interactionRunner.authHeaders).
//   fetchImpl    — fetch implementation; injected for tests (default: global fetch).
//   timeoutMs    — client timeout (server hold + margin).
//   query        — query string appended to /get_url (e.g. "?v=1.3.14&caps=...&client=extension").
export async function pollGetUrl(controlUrl, { signal, authHeaders, fetchImpl = fetch, timeoutMs, query = '' } = {}) {
    if (typeof authHeaders !== 'function') { throw new Error('pollGetUrl requires an authHeaders() function'); }
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) { throw new Error('pollGetUrl requires a positive timeoutMs'); }

    const controller = new AbortController();
    let abortReason = null;
    const onExternalAbort = () => { abortReason = 'external'; controller.abort(); };

    if (signal) {
        if (signal.aborted) { abortReason = 'external'; controller.abort(); }
        else { signal.addEventListener('abort', onExternalAbort, { once: true }); }
    }
    const timer = setTimeout(() => { abortReason = 'timeout'; controller.abort(); }, timeoutMs);

    // Rejects with a typed AbortError the instant our controller aborts. Used to race the NON-abortable
    // authHeaders() (chrome.storage) against cancellation, so a stop/timeout returns promptly even if a
    // storage read is momentarily slow — cancellation must cover the WHOLE operation, not just fetch.
    const cancellation = () => new Promise((_resolve, reject) => {
        if (controller.signal.aborted) { reject(makeAbortError(abortReason)); return; }
        controller.signal.addEventListener('abort', () => reject(makeAbortError(abortReason)), { once: true });
    });

    try {
        // authHeaders() is converted to a non-rejecting result so an auth/storage FAILURE always wins
        // deterministically over a coincident abort → it is surfaced fail-loud, NEVER masked as timeout.
        const authOutcome = await Promise.race([
            authHeaders().then((headers) => ({ headers }), (error) => ({ error })),
            cancellation(),
        ]);
        if (authOutcome.error) { throw withPollCategory(authOutcome.error, 'auth'); }
        const response = await fetchImpl(`${controlUrl}/get_url${query}`, { headers: authOutcome.headers, signal: controller.signal });
        if (response.status === 204) { return { type: POLL_RESULT.EMPTY }; }
        if (!response.ok) { throw withPollCategory(new Error(`get_url HTTP ${response.status}`), 'http'); }
        let data;
        try {
            data = await response.json();
        } catch (error) {
            throw withPollCategory(error, 'protocol');
        }
        return { type: POLL_RESULT.PAYLOAD, data };
    } catch (err) {
        // Normalize OUR abort (native fetch AbortError or the cancellation racer) to carry a distinct
        // reason. Anything else — auth/storage failure, HTTP, network — propagates unchanged (fail loud).
        if (err && err.name === 'AbortError' && controller.signal.aborted && abortReason) {
            throw makeAbortError(abortReason);
        }
        throw err?.pollCategory ? err : withPollCategory(err, 'network');
    } finally {
        clearTimeout(timer);
        if (signal) { signal.removeEventListener('abort', onExternalAbort); }
    }
}

function makeAbortError(reason) {
    const e = new Error(reason === 'timeout' ? 'poll request timed out' : 'poll aborted by controller');
    e.name = 'AbortError';
    e.reason = reason || 'external';
    return e;
}
