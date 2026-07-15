// pollAdapter.js — bridges the one-poll transport to the controller's pollOnce contract.
//
// The controller expects `pollOnce(controlUrl, {signal}) → true (continue) | false (stop) | throw`.
// This adapter maps the transport's outcomes:
//   - timeout (AbortError reason 'timeout') → return true: a held poll ended; start a replacement poll;
//   - external abort (AbortError reason 'external') → re-throw: the controller sees signal.aborted and
//     exits as stopped/reconfigured (NOT an error);
//   - payload → dispatch it, then return true;
//   - empty (204) → return true;
//   - any other error (auth/HTTP/network) → re-throw: the controller records 'exception' and the alarm
//     recovers on the next reconcile.
import { POLL_REQUEST_TIMEOUT_MS, POLL_RESULT, pollGetUrl } from './pollTransport.js';

export function makePollOnce({
    authHeaders,
    timeoutMs = POLL_REQUEST_TIMEOUT_MS,
    query = '',
    dispatch,
    pollGetUrlImpl = pollGetUrl,
} = {}) {
    if (typeof authHeaders !== 'function') { throw new Error('makePollOnce requires an authHeaders() function'); }
    if (typeof dispatch !== 'function') { throw new Error('makePollOnce requires a dispatch(payload, controlUrl) function'); }
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) { throw new Error('makePollOnce requires a positive timeoutMs'); }
    if (typeof pollGetUrlImpl !== 'function') { throw new Error('makePollOnce requires a pollGetUrl implementation'); }
    return async (controlUrl, { signal } = {}) => {
        let result;
        try {
            result = await pollGetUrlImpl(controlUrl, { signal, authHeaders, timeoutMs, query });
        } catch (err) {
            if (err && err.name === 'AbortError' && err.reason === 'timeout') { return true; }   // repoll
            throw err;   // external abort → controller sees signal.aborted; other → exception
        }
        if (!result || typeof result !== 'object') {
            throw new Error('poll transport returned a malformed result');
        }
        if (result.type === POLL_RESULT.EMPTY) { return true; }
        if (result.type !== POLL_RESULT.PAYLOAD) {
            throw new Error(`poll transport returned unknown result type: ${String(result.type)}`);
        }
        if (!result.data || typeof result.data !== 'object' || Array.isArray(result.data)) {
            throw new Error('poll transport returned a payload without an object body');
        }
        await dispatch(result.data, controlUrl);
        return true;
    };
}
