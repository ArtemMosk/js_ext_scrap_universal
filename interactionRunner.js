// Interaction task orchestrator (background side).
// Executes a browser_interaction task: a sequence of steps (navigate, type, click,
// waitFor, extract, ...) against a tab. All waiting loops live HERE, not in the
// content script: every chrome.tabs.sendMessage resets the MV3 service-worker idle
// timer, so multi-minute waits (e.g. an AI chat generating a reply/image) survive without long-lived
// ports that a worker restart would sever.
import Logger from './logger.js';
import ScreenshotCapture from './backgroundScreenshotHandler.js';

const runnerLogger = new Logger('INTERACT');

const DEFAULT_TASK_TIMEOUT_SEC = 240;
const MAX_TASK_TIMEOUT_SEC = 480; // matches the 8-minute processing ceiling in processUrl
const HEARTBEAT_INTERVAL_MS = 30000;
const FAILURE_SCREENSHOT_TIMEOUT_MS = 8000;

function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

// Re-fetch an image from the background service worker (host_permissions bypass the
// CORS restriction a content-script fetch hits on cross-origin CDN images).
// Service workers have no FileReader, so base64-encode the ArrayBuffer manually.
async function backgroundFetchImage(src) {
    const resp = await fetch(src);
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    const buf = await resp.arrayBuffer();
    const MAX = 20 * 1024 * 1024;
    if (buf.byteLength > MAX) throw new Error(`image ${buf.byteLength}B exceeds ${MAX}B cap`);
    const mime = (resp.headers.get('content-type') || 'image/png').split(';')[0];
    const bytes = new Uint8Array(buf);
    let binary = '';
    const CHUNK = 0x8000;
    for (let i = 0; i < bytes.length; i += CHUNK) {
        binary += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK));
    }
    return { dataUrl: `data:${mime};base64,${btoa(binary)}`, mime, bytes: buf.byteLength };
}

class StepError extends Error {
    constructor(index, step, message) {
        const what = step.selector ? `${step.action} "${step.selector}"` : step.action;
        super(`step ${index} (${what}): ${message}`);
        this.stepIndex = index;
    }
}

async function sendStep(tabId, step) {
    for (let attempt = 1; attempt <= 3; attempt++) {
        try {
            return await chrome.tabs.sendMessage(tabId, { type: 'interaction_step', step });
        } catch (error) {
            // Content script not there yet (slow SPA boot, navigation race) - inject and retry
            if (error.message && error.message.includes('Receiving end does not exist') && attempt < 3) {
                runnerLogger.warn('Content script unreachable, injecting', { tabId, attempt });
                try {
                    await chrome.scripting.executeScript({
                        target: { tabId },
                        files: ['interactionExecutor.js']
                    });
                } catch (injectError) {
                    runnerLogger.error('Injection failed', { tabId, error: injectError.message });
                }
                await sleep(500 * attempt);
                continue;
            }
            throw error;
        }
    }
    throw new Error('content script unreachable after 3 injection attempts');
}

// Trace frames are bounded — debug must not turn the result store into a byte sink.
export const MAX_TRACE_FRAMES = 40;
export function pushFrame(frames, frame) {
    if (!frames) return false;
    if (frames.length >= MAX_TRACE_FRAMES) {
        if (frames.length === MAX_TRACE_FRAMES) {
            frames.push({ t: new Date().toISOString(), phase: 'capped',
                          note: `trace capped at ${MAX_TRACE_FRAMES} frames` });
        }
        return false;
    }
    frames.push(frame);
    return true;
}

// Pure: the wire message a click step sends to the executor (exported for node tests).
export function buildClickStep(step) {
    return { action: 'click', selector: step.selector, pick: step.pick,
             exclude_within: step.exclude_within, text_match: step.text_match };
}

function remainingMs(deadline, index, step) {
    const left = deadline - Date.now();
    if (left <= 0) throw new StepError(index, step, 'task timeout exceeded');
    return left;
}

async function waitForState(tabId, step, index, deadline, baselineSrc = null) {
    const state = step.state || 'visible';
    const pollMs = step.poll_ms || 500;
    const timeoutMs = Math.min(step.timeout_ms || 30000, remainingMs(deadline, index, step));
    const until = Date.now() + timeoutMs;
    let lastSrc = null, stableSince = 0;

    while (Date.now() < until) {
        // forward exclude_within + min_natural_width so the check honours the same filtering as the
        // step (skip the user turn's reference image; size-filter so pick 'last' = newest big image).
        const res = await sendStep(tabId, {
            action: 'check', selector: step.selector, pick: step.pick,
            exclude_within: step.exclude_within, min_natural_width: step.min_natural_width });
        // optional size gate: wait for an actually-large image (skip spinners/placeholders)
        const bigEnough = !step.min_natural_width || (res.naturalWidth || 0) >= step.min_natural_width;
        // optional count gate: wait until >= N elements match (e.g. N attachment previews)
        const countOk = !step.min_count || (res.count || 0) >= step.min_count;
        let satisfied =
            state === 'visible' ? (res.exists && res.visible && bigEnough && countOk) :
            state === 'hidden' ? (!res.exists || !res.visible) :
            state === 'attached' ? res.exists :
            state === 'detached' ? !res.exists :
            null;
        if (satisfied === null) throw new StepError(index, step, `unknown state "${state}"`);
        // conversation reuse: require a NEW image (src differs from the one present before we sent),
        // otherwise the wait matches the previous generation that's already on screen.
        if (satisfied && step.src_change && res.src && res.src === baselineSrc) satisfied = false;
        // optional stability gate: the matched src must hold steady for stable_ms (e.g. wait for a
        // progressively-rendered generated image to settle, not a transient preview).
        if (satisfied && step.stable_ms) {
            if (res.src && res.src === lastSrc) {
                if (Date.now() - stableSince < step.stable_ms) satisfied = false;
            } else { lastSrc = res.src; stableSince = Date.now(); satisfied = false; }
        }
        if (satisfied) return;
        await sleep(Math.min(pollMs, Math.max(50, until - Date.now())));
    }
    throw new StepError(index, step, `condition "${state}" not met within ${timeoutMs}ms`);
}

async function waitForStableText(tabId, step, index, deadline) {
    const pollMs = step.poll_ms || 750;
    const quietMs = step.quiet_ms || 2500;
    const timeoutMs = Math.min(step.timeout_ms || 180000, remainingMs(deadline, index, step));
    const until = Date.now() + timeoutMs;

    let lastHash = null;
    let stableSince = null;

    while (Date.now() < until) {
        const res = await sendStep(tabId, { action: 'check', selector: step.selector, pick: step.pick || 'last' });
        if (res.exists && res.textLength > 0) {
            if (res.textHash === lastHash) {
                if (stableSince && Date.now() - stableSince >= quietMs) return;
                stableSince = stableSince || Date.now();
            } else {
                lastHash = res.textHash;
                stableSince = Date.now();
            }
        } else {
            lastHash = null;
            stableSince = null;
        }
        await sleep(pollMs);
    }
    throw new StepError(index, step, `text did not stabilize within ${timeoutMs}ms`);
}

async function clickWithEnableWait(tabId, step, index, deadline) {
    const waitMs = Math.min(step.wait_enabled_ms || 2000, remainingMs(deadline, index, step));
    const until = Date.now() + waitMs;
    let lastError = 'unknown';

    do {
        // Forward the full click contract — text_match/exclude_within are part of the
        // clickTextMatch capability for ALL clicks, not only awaitResult's internal ones.
        const res = await sendStep(tabId, buildClickStep(step));
        if (res.ok) return;
        lastError = res.error;
        // disabled/missing can be transient (React enables the button after input registers)
        if (!res.disabled && !res.missing) throw new StepError(index, step, res.error);
        await sleep(250);
    } while (Date.now() < until);

    throw new StepError(index, step, `${lastError} (after waiting ${waitMs}ms)`);
}

// Bring a tab's WINDOW to the foreground (focused + un-minimized). A minimized/occluded Chrome
// window is throttled by the OS/Chrome — even the active tab won't reliably DECODE images
// (naturalWidth stays 0), which makes generations intermittently look wedged. Best-effort.
async function ensureWindowVisible(tabId) {
    try {
        const tab = await chrome.tabs.get(tabId);
        if (tab && tab.windowId != null) {
            await chrome.windows.update(tab.windowId, { focused: true, state: 'normal' });
        }
    } catch (_) { /* best effort — headless/no-window contexts */ }
}

async function navigate(tabId, step, deps) {
    let id = tabId;
    if (id === null) {
        // active:true - synthetic typing via execCommand is unreliable in unfocused documents
        const tab = await chrome.tabs.create({ url: step.url, active: true });
        id = tab.id;
    } else {
        await chrome.tabs.update(id, { url: step.url, active: true });
    }
    await ensureWindowVisible(id);   // un-minimize + focus so image decode isn't throttled
    deps.networkTracker.setTargetUrl(id, step.url);
    await deps.waitForTabLoad(id, false);
    return id;
}

// Pure decision: which reuse context to store when a task ends (B6 fail-loud rule).
// A task may CLAIM its context only after SUCCESS — a failed upload/send must never leave a
// context that lets the next request skip uploadFile. If we were legitimately reusing a
// matching context (established by a prior success), that context is still true of the
// conversation and is kept; otherwise the tab is stored context-less (warm tab, but the next
// conversation request must navigate+upload fresh).
export function nextReuseContext({ success, reusedWithMatch, reuseContext, poisoned = false }) {
    if (poisoned) return '';   // wedged/poisoned conversation must NEVER be reused (codex §review)
    if (success) return reuseContext;
    return reusedWithMatch ? reuseContext : '';
}

// Per-attempt budget so retries FIT inside the task budget with margin reserved for the
// final stop-click + result submission (codex correction: fixed budgets overrun the task).
export function deriveAttemptBudget(timeoutMs, maxRetries, stopMarginMs = 20000) {
    const attempts = Math.max(1, (Number(maxRetries) || 0) + 1);
    return Math.max(15000, Math.floor((timeoutMs - stopMarginMs) / attempts));
}

// Optional bearer auth (server deployments that set API_BEARER_TOKEN): the token is configured
// in the popup and MUST ride on every server call, or an authed server 401s the whole loop.
export async function authHeaders(extra = {}) {
    try {
        const { apiToken } = await chrome.storage.sync.get(['apiToken']);
        return apiToken ? { ...extra, 'Authorization': `Bearer ${apiToken}` } : extra;
    } catch (_) {
        return extra;
    }
}

function startHeartbeat(controlUrl, taskId) {
    return setInterval(async () => {
        fetch(`${controlUrl}/task_heartbeat/${taskId}`,
              { method: 'POST', headers: await authHeaders() })
            .catch(error => runnerLogger.warn('Heartbeat failed', { taskId, error: error.message }));
    }, HEARTBEAT_INTERVAL_MS);
}

async function submitResult(controlUrl, result) {
    const response = await fetch(`${controlUrl}/submit_task`, {
        method: 'POST',
        headers: await authHeaders({ 'Content-Type': 'application/json' }),
        body: JSON.stringify({ task_id: result.task_id, result })
    });
    const text = await response.text();
    if (!response.ok) {
        throw new Error(`submit_task responded ${response.status}: ${text.substring(0, 200)}`);
    }
    runnerLogger.info('Result submitted', { taskId: result.task_id, status: result.status });
}

// Optional diagnostic capture (step.trace_ms > 0, user-authorized): screenshot + rich DOM probe
// + main-image state on a cadence, collected into `traceFrames` and returned via result metadata.
// Lets us watch WHAT the page does during a wedge without guessing.
async function captureTraceFrame(tabId, attempt, phase, res) {
    const frame = {
        t: new Date().toISOString(), attempt, phase,
        mainImg: { exists: !!res.exists, visible: !!res.visible, count: res.count,
                   naturalWidth: res.naturalWidth || 0, src: (res.src || '').slice(0, 140) }
    };
    // NEWEST assistant image regardless of size (min_natural_width:0) — this catches the 0×0
    // element that the size-filtered success check skips, WITH geometry so we can tell
    // decode-throttle (inViewport true, naturalWidth 0) from lazy-out-of-view (inViewport false).
    try {
        const ni = await sendStep(tabId, { action: 'check', selector: 'main img', pick: 'last',
            exclude_within: '[data-message-author-role="user"]', min_natural_width: 0 });
        frame.newestImg = {
            naturalWidth: ni.naturalWidth, inViewport: ni.inViewport, rect: ni.rect,
            loading: ni.loading, complete: ni.complete, count: ni.count,
            innerHeight: ni.innerHeight, scrollY: ni.scrollY, docVisibility: ni.docVisibility,
            src: (ni.src || '').slice(0, 90)
        };
    } catch (_) {}
    try { const p = await sendStep(tabId, { action: 'probe' }); frame.dom = p && p.data && p.data.text; } catch (_) {}
    try { frame.screenshot = await new ScreenshotCapture().captureFullPage(tabId); } catch (_) {}
    return frame;
}

// Result wait with in-conversation recovery (generic; all selectors/patterns are step DATA):
// per attempt: race success-check vs error-patterns; on error → click the site's own retry
// control (≤max_retries, same conversation — no new threads); on a WEDGED attempt (no error,
// no result) → stop-click, try retry control once, else fail loud and POISON the conversation.
async function awaitResultStep(tabId, step, index, deadline, baselineSrc, traceFrames = null) {
    const success = step.success || {};
    const maxRetries = step.max_retries != null ? step.max_retries : 2;
    const timeoutMs = Math.min(step.timeout_ms || 240000, remainingMs(deadline, index, step));
    const budget = deriveAttemptBudget(timeoutMs, maxRetries);
    const pollMs = step.poll_ms || 1500;
    const traceMs = (traceFrames && step.trace_ms) ? step.trace_ms : 0;
    let lastErrorSnippet = null, lastTrace = 0;

    for (let attempt = 0; attempt <= maxRetries; attempt++) {
        const until = Date.now() + Math.min(budget, Math.max(5000, remainingMs(deadline, index, step) - 15000));
        let lastSrc = null, stableSince = 0, erroredThisAttempt = false;

        while (Date.now() < until) {
            // ROOT-CAUSE FIX (proven 2026-07-05: generated images are loading="lazy"): scroll the
            // NEWEST image (any size, incl. a not-yet-loaded 0×0 one) into view each poll, so a
            // lazy image below the fold actually loads. The size-filtered success check below would
            // otherwise skip the 0×0 element and never trigger its load → the "wedge".
            // Toggle (step.scroll_result:false) disables it for A/B reproduction of the raw bug.
            if (step.scroll_result !== false) {
                await sendStep(tabId, {
                    action: 'check', selector: success.selector, pick: 'last',
                    exclude_within: success.exclude_within, min_natural_width: 0,
                    scroll_into_view: true }).catch(() => ({}));
            }
            const res = await sendStep(tabId, {
                action: 'check', selector: success.selector, pick: success.pick,
                exclude_within: success.exclude_within,
                min_natural_width: success.min_natural_width });
            if (traceMs && Date.now() - lastTrace >= traceMs) {
                lastTrace = Date.now();
                pushFrame(traceFrames, await captureTraceFrame(tabId, attempt, 'waiting', res));
            }
            const bigEnough = !success.min_natural_width || (res.naturalWidth || 0) >= success.min_natural_width;
            let satisfied = !!(res.exists && res.visible && bigEnough);
            if (satisfied && success.src_change && res.src && res.src === baselineSrc) satisfied = false;
            if (satisfied && success.stable_ms) {
                if (res.src && res.src === lastSrc) {
                    if (Date.now() - stableSince < success.stable_ms) satisfied = false;
                } else { lastSrc = res.src; stableSince = Date.now(); satisfied = false; }
            }
            if (satisfied) {
                runnerLogger.info('awaitResult: success', { attempt: attempt + 1 });
                return;
            }
            if (step.error && Array.isArray(step.error.patterns) && step.error.patterns.length) {
                const probe = await sendStep(tabId, {
                    action: 'detectTextPatterns', patterns: step.error.patterns,
                    flags: step.error.flags, label: step.error.label || 'gen_error',
                    fail_on_match: false });
                if (probe && probe.pattern_detected) {
                    lastErrorSnippet = probe.snippet || '';
                    erroredThisAttempt = true;
                    runnerLogger.warn('awaitResult: error state detected', { attempt: attempt + 1, snippet: lastErrorSnippet });
                    break;
                }
            }
            await sleep(Math.min(pollMs, Math.max(100, until - Date.now())));
        }

        if (erroredThisAttempt) {
            if (attempt < maxRetries && step.retry) {
                const clicked = await sendStep(tabId, {
                    action: 'click', selector: step.retry.selector,
                    text_match: step.retry.text_match }).catch(() => ({ ok: false }));
                if (clicked && clicked.ok) {
                    runnerLogger.warn('awaitResult: clicked retry control', { attempt: attempt + 1 });
                    continue;
                }
                throw new StepError(index, step,
                    `IMAGE_GENERATION_FAILED (retry control not clickable) after ${attempt + 1} attempt(s): ${lastErrorSnippet}`);
            }
            throw new StepError(index, step,
                `IMAGE_GENERATION_FAILED after ${attempt + 1} attempt(s): ${lastErrorSnippet}`);
        }

        // Wedged: no result, no error banner. Capture a final diagnostic frame BEFORE we stop
        // (so we see the wedged state), then free the account slot.
        if (traceMs) {
            const res = await sendStep(tabId, { action: 'check', selector: success.selector,
                pick: success.pick, exclude_within: success.exclude_within,
                min_natural_width: success.min_natural_width }).catch(() => ({}));
            pushFrame(traceFrames, await captureTraceFrame(tabId, attempt, 'wedged', res));
        }
        // Free the account slot, then try the site's retry control once (some sites surface it
        // after stopping); else poison + fail loud.
        if (step.cancel) {
            await sendStep(tabId, { action: 'click', selector: step.cancel.selector,
                                    text_match: step.cancel.text_match }).catch(() => ({}));
        }
        if (attempt < maxRetries && step.retry) {
            await sleep(1500);
            const retried = await sendStep(tabId, {
                action: 'click', selector: step.retry.selector,
                text_match: step.retry.text_match }).catch(() => ({ ok: false }));
            if (retried && retried.ok) {
                runnerLogger.warn('awaitResult: stopped wedged attempt, retry control clicked', { attempt: attempt + 1 });
                continue;
            }
        }
        const err = new StepError(index, step,
            `IMAGE_GENERATION_WEDGED after ${attempt + 1} attempt(s) (${budget}ms each; no error banner, no result)`);
        err.poisonReuse = true;
        throw err;
    }
}

export async function runInteractionTask(task, controlUrl, deps) {
    const params = task.params || {};
    const steps = params.steps;
    if (!Array.isArray(steps) || steps.length === 0) {
        throw new Error(`Task ${task.task_id} has no params.steps`);
    }

    const timeoutSec = Math.min(params.timeout_sec || DEFAULT_TASK_TIMEOUT_SEC, MAX_TASK_TIMEOUT_SEC);
    const deadline = Date.now() + timeoutSec * 1000;
    const workerId = `extension-${chrome.runtime.id}`;
    const startedAt = new Date().toISOString();
    const items = [];
    const traceFrames = [];   // filled only when an awaitResult step sets trace_ms (diagnostic)
    let tabId = null;
    let stepsExecuted = 0;

    // Optional tab/conversation reuse (throttle optimisation): reuse a persistent tab if it's
    // still open. 'conversation' also keeps the same chat (ref stays uploaded); 'warm' reuses the
    // tab but starts a fresh chat. Falls back to a new tab if the persistent one is gone.
    const reuseMode = params.reuse_mode || 'fresh';
    const reuseContext = params.reuse_context || '';
    let baselineSrc = null;
    let reusing = false;
    let contextMatches = false;  // may skip navigate+upload only when the stored context matches
    let taskSucceeded = false;
    let poisonReuse = false;     // wedged conversation: never store it for reuse (see finally)
    if (reuseMode !== 'fresh' && deps.getReuseTab) {
        const stored = await deps.getReuseTab();
        if (stored && stored.id != null) {
            try {
                await chrome.tabs.get(stored.id);
                tabId = stored.id; reusing = true;
                contextMatches = (stored.context || '') === reuseContext;
                // CRITICAL: bring the reused tab + its window to the foreground. A fresh tab is
                // created active; a reused tab defaults to the BACKGROUND, and Chrome throttles
                // background/minimized contexts — the newly generated image won't DECODE
                // (naturalWidth stays 0), looking like a wedge though ChatGPT produced it fine.
                try { await chrome.tabs.update(stored.id, { active: true }); } catch (_) {}
                await ensureWindowVisible(stored.id);
            } catch (_) { /* tab gone -> new */ }
        }
    }

    runnerLogger.info('Starting interaction task', {
        taskId: task.task_id, steps: steps.length, timeoutSec, reuseMode, reusing
    });

    const heartbeat = startHeartbeat(controlUrl, task.task_id);

    try {
        for (let i = 0; i < steps.length; i++) {
            const step = steps[i];
            remainingMs(deadline, i, step);
            runnerLogger.debug(`Step ${i}: ${step.action}`, { selector: step.selector });

            // Conversation reuse: the tab is already on the chat with the SAME reference attached
            // (context match), so skip re-navigating and re-uploading. If the context differs
            // (changed/absent ref, or different scope), we DON'T skip — navigate+upload run so the
            // new reference is actually attached (never claim a ref was used when it wasn't).
            // Capture the newest-image src just before send so waitFor(src_change) sees the NEW one.
            if (reusing && reuseMode === 'conversation' && contextMatches) {
                if (step.action === 'navigate' || step.action === 'uploadFile') { stepsExecuted++; continue; }
                if (step.action === 'type' && baselineSrc === null) {
                    const b = await sendStep(tabId, { action: 'check', selector: 'main img', pick: 'last',
                        exclude_within: '[data-message-author-role="user"]', min_natural_width: 700 });
                    baselineSrc = b.src || '';
                }
            }

            try {
                switch (step.action) {
                    case 'navigate':
                        tabId = await navigate(tabId, step, deps);
                        break;
                    case 'sleep':
                        await sleep(Math.min(step.ms || 1000, remainingMs(deadline, i, step)));
                        break;
                    case 'windowState': {
                        // Diagnostic/control: force the tab's window minimized|normal (background-tab
                        // decode-throttle experiment). Window API is background-only, so it lives here.
                        try {
                            const t = await chrome.tabs.get(tabId);
                            if (t && t.windowId != null) {
                                await chrome.windows.update(t.windowId, { state: step.state || 'normal' });
                            }
                        } catch (e) { runnerLogger.warn('windowState failed', { error: e.message }); }
                        break;
                    }
                    case 'pageReload': {
                        // Reload the page (tests whether a not-yet-rendered image appears after a
                        // fresh load — a lazy-load vs never-generated discriminator). Waits for load.
                        try {
                            await chrome.tabs.reload(tabId);
                            await deps.waitForTabLoad(tabId, false);
                        } catch (e) { runnerLogger.warn('reload failed', { error: e.message }); }
                        break;
                    }
                    case 'debugWatch': {
                        // PURE OBSERVATION (never fails/poisons/closes): for duration_ms, every
                        // interval_ms capture a full frame (screenshot + DOM + newest-image geometry)
                        // into traceFrames. Optional scroll:true scrolls the newest image into view
                        // each tick. Lets us watch exactly what the page does without the fail-loud
                        // machinery interfering — and keep the tab open for the user to observe.
                        const dwUntil = Date.now() + Math.min(step.duration_ms || 90000,
                            remainingMs(deadline, i, step));
                        const dwInterval = step.interval_ms || 8000;
                        const dwSel = step.selector || 'main img';
                        const dwExclude = step.exclude_within || '[data-message-author-role="user"]';
                        runnerLogger.info('debugWatch started', { duration: step.duration_ms, scroll: !!step.scroll });
                        while (Date.now() < dwUntil) {
                            if (step.scroll) {
                                await sendStep(tabId, { action: 'check', selector: dwSel, pick: 'last',
                                    exclude_within: dwExclude, min_natural_width: 0,
                                    scroll_into_view: true }).catch(() => ({}));
                            }
                            const res = await sendStep(tabId, { action: 'check', selector: dwSel,
                                pick: 'last', exclude_within: dwExclude, min_natural_width: 0 })
                                .catch(() => ({}));
                            pushFrame(traceFrames, await captureTraceFrame(tabId, 0, 'debugWatch', res));
                            await sleep(Math.min(dwInterval, Math.max(200, dwUntil - Date.now())));
                        }
                        break;
                    }
                    case 'waitFor':
                        await waitForState(tabId, step, i, deadline, baselineSrc);
                        break;
                    case 'waitForStableText':
                        await waitForStableText(tabId, step, i, deadline);
                        break;
                    case 'click':
                        await clickWithEnableWait(tabId, step, i, deadline);
                        break;
                    case 'type':
                    case 'press':
                    case 'uploadFile':
                    case 'detectTextPatterns': {
                        const res = await sendStep(tabId, step);
                        if (!res.ok) throw new StepError(i, step, res.error);
                        break;
                    }
                    case 'awaitResult': {
                        await awaitResultStep(tabId, step, i, deadline, baselineSrc, traceFrames);
                        break;
                    }
                    case 'extract':
                    case 'probe': {
                        const res = await sendStep(tabId, step);
                        if (!res.ok) throw new StepError(i, step, res.error);
                        items.push({
                            name: step.as || `${step.action}_${i}`,
                            content: res.data.text !== undefined ? res.data.text : JSON.stringify(res.data),
                            source_url: res.data.url || null,
                            title: res.data.title || null
                        });
                        break;
                    }
                    case 'extractImage': {
                        const res = await sendStep(tabId, step);
                        if (!res.ok) throw new StepError(i, step, res.error);
                        let d = res.data;
                        if (d.needsBackgroundFetch && d.src_url) {
                            try {
                                const bg = await backgroundFetchImage(d.src_url);
                                d = { ...d, ...bg, needsBackgroundFetch: false };
                            } catch (bgErr) {
                                throw new StepError(i, step, `image fetch failed (page + background): ${bgErr.message}`);
                            }
                        }
                        if (!d.dataUrl) throw new StepError(i, step, 'extractImage: no image data captured');
                        items.push({
                            name: step.as || `image_${i}`,
                            type: 'image',
                            mime: d.mime || null,
                            bytes: d.bytes || null,
                            content: d.dataUrl,          // base64 data URL, same channel as screenshots
                            source_url: d.src_url || d.url || null,
                            width: d.width || null,
                            height: d.height || null
                        });
                        break;
                    }
                    default:
                        throw new StepError(i, step, `unknown action "${step.action}"`);
                }
            } catch (stepError) {
                if (step.optional) {
                    runnerLogger.warn(`Optional step ${i} failed, continuing`, {
                        action: step.action, error: stepError.message
                    });
                } else {
                    throw stepError instanceof StepError ? stepError : new StepError(i, step, stepError.message);
                }
            }
            stepsExecuted++;
        }

        let screenshot = null;
        if (params.capture_screenshot && tabId !== null) {
            try {
                screenshot = await new ScreenshotCapture().captureFullPage(tabId);
            } catch (screenshotError) {
                runnerLogger.warn('Final screenshot failed', { error: screenshotError.message });
            }
        }

        let finalUrl = null;
        try {
            finalUrl = tabId !== null ? (await chrome.tabs.get(tabId)).url : null;
        } catch (_) { /* tab may already be gone */ }

        const result = {
            task_id: task.task_id,
            task_type: task.task_type,
            status: 'completed',
            worker_id: workerId,
            started_at: startedAt,
            completed_at: new Date().toISOString(),
            items: items,
            summary: items.length > 0 ? String(items[0].content).substring(0, 200) : null,
            metadata: {
                steps_executed: stepsExecuted,
                final_url: finalUrl,
                screenshot: screenshot,
                trace: traceFrames.length ? traceFrames : undefined,
                evidence: traceFrames.length ? { task_id: task.task_id,
                    captured_at: new Date().toISOString(), trace: traceFrames } : undefined
            }
        };
        await submitResult(controlUrl, result);
        taskSucceeded = true;
        return result;
    } catch (error) {
        runnerLogger.error('Interaction task failed', {
            taskId: task.task_id, error: error.message, stepsExecuted
        });
        if (error && error.poisonReuse) poisonReuse = true;
        // FAILURE ORDER MATTERS (obs contract, amendment M1): everything that READS the page
        // state must run BEFORE the stop/cancel click — stopping can dismiss the rate-limit
        // banner (account-protection miss) and erase the failure state (evidence loss).
        // Order: 1) banner probe  2) pre-cancel evidence  3) cancel click  4) post-cancel probe.
        let rateLimited = /PATTERN_DETECTED\[rate_limit\]/.test(error.message || '');
        // 1. ACCOUNT PROTECTION IS NOT DEBUG-GATED: always re-probe for a late rate-limit banner
        // using the task's own patterns (cheap innerText scan) — BEFORE cancel dismisses it.
        if (tabId !== null && !rateLimited) {
            try {
                const detectStep = (steps || []).find(
                    s => s.action === 'detectTextPatterns' && (s.label || 'pattern') === 'rate_limit');
                if (detectStep) {
                    const r = await sendStep(tabId, { ...detectStep, fail_on_match: false });
                    if (r && r.pattern_detected) rateLimited = true;
                }
            } catch (_) {}
        }
        // 2. Pre-cancel evidence (opt-in): screenshot + DOM of the ACTUAL failure state.
        const evidence = { task_id: task.task_id, captured_at: new Date().toISOString() };
        let debug = null;
        if (params.debug_on_failure && tabId !== null) {
            const failure = { capture_errors: [] };
            const screenshotTimeoutMs = Math.min(
                Math.max(1, Number(params.debug_screenshot_timeout_ms) || FAILURE_SCREENSHOT_TIMEOUT_MS),
                FAILURE_SCREENSHOT_TIMEOUT_MS
            );
            try {
                failure.screenshot = await new ScreenshotCapture().captureFullPage(
                    tabId, { timeoutMs: screenshotTimeoutMs });
            }
            catch (e) { failure.capture_errors.push(`screenshot: ${e.message}`); }
            try { const p = await sendStep(tabId, { action: 'probe' }); failure.dom = p && p.data && p.data.text; }
            catch (e) { failure.capture_errors.push(`probe: ${e.message}`); }
            evidence.failure = failure;
            debug = { rate_limited: rateLimited, screenshot: failure.screenshot, dom: failure.dom };
        }
        // 3. FM3 cancel-on-abandon: the site runs ONE generation job per account — a job we
        // abandon must be stopped, or it silently blocks every later request. Best-effort.
        if (tabId !== null && params.cancel_selector) {
            try {
                await sendStep(tabId, { action: 'click', selector: params.cancel_selector });
                runnerLogger.warn('cancel-on-abandon: stop control clicked', { taskId: task.task_id });
            } catch (_) { /* best effort */ }
            // 4. Post-cancel state, marked separately (never overwrites the failure evidence).
            if (params.debug_on_failure) {
                try {
                    const p = await sendStep(tabId, { action: 'probe' });
                    evidence.post_cancel = { dom: p && p.data && p.data.text, capture_errors: [] };
                } catch (e) { evidence.post_cancel = { capture_errors: [`probe: ${e.message}`] }; }
            }
        }
        if (traceFrames.length) evidence.trace = traceFrames;
        const hasEvidence = !!(evidence.failure || evidence.post_cancel || evidence.trace);
        try {
            await submitResult(controlUrl, {
                task_id: task.task_id,
                task_type: task.task_type,
                status: 'failed',
                worker_id: workerId,
                started_at: startedAt,
                completed_at: new Date().toISOString(),
                error: error.message,
                items: items,
                summary: null,
                metadata: { steps_executed: stepsExecuted, rate_limited: rateLimited, debug: debug,
                            trace: traceFrames.length ? traceFrames : undefined,
                            evidence: hasEvidence ? evidence : undefined }
            });
        } catch (submitError) {
            runnerLogger.error('Failed to submit failure result', {
                taskId: task.task_id, error: submitError.message
            });
        }
        throw error;
    } finally {
        clearInterval(heartbeat);
        // Reuse modes keep the tab alive for the next request; only fresh mode closes it.
        // Store the tab WITH the context it now holds (reuse scope + reference set), so the next
        // task can decide whether skipping navigate+upload is actually safe (B3).
        // POISONED conversations (wedged generation) are never stored and their tab is closed —
        // reusing one would re-enter the hang (codex review blocker 1).
        if (poisonReuse) {
            if (deps.setReuseTab) { try { await deps.setReuseTab(null, ''); } catch (_) { /* ignore */ } }
            if (tabId !== null && !params.keep_tab_open) {
                try { await chrome.tabs.remove(tabId); } catch (_) { /* may already be gone */ }
            }
        } else if (reuseMode !== 'fresh' && tabId !== null && deps.setReuseTab) {
            const storedContext = nextReuseContext({
                success: taskSucceeded,
                reusedWithMatch: reusing && contextMatches,
                reuseContext,
                poisoned: false
            });
            try { await deps.setReuseTab(tabId, storedContext); } catch (_) { /* ignore */ }
        }
        if (tabId !== null && !params.keep_tab_open && reuseMode === 'fresh') {
            try {
                await chrome.tabs.remove(tabId);
            } catch (closeError) {
                runnerLogger.warn('Failed to close task tab', { tabId, error: closeError.message });
            }
        }
    }
}
