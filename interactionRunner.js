// Interaction task orchestrator (background side).
// Executes a browser_interaction task: a sequence of steps (navigate, type, click,
// waitFor, extract, ...) against a tab. All waiting loops live HERE, not in the
// content script: every chrome.tabs.sendMessage resets the MV3 service-worker idle
// timer, so multi-minute waits (e.g. ChatGPT generating) survive without long-lived
// ports that a worker restart would sever.
import Logger from './logger.js';
import ScreenshotCapture from './backgroundScreenshotHandler.js';

const runnerLogger = new Logger('INTERACT');

const DEFAULT_TASK_TIMEOUT_SEC = 240;
const MAX_TASK_TIMEOUT_SEC = 480; // matches the 8-minute processing ceiling in processUrl
const HEARTBEAT_INTERVAL_MS = 30000;

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

function remainingMs(deadline, index, step) {
    const left = deadline - Date.now();
    if (left <= 0) throw new StepError(index, step, 'task timeout exceeded');
    return left;
}

async function waitForState(tabId, step, index, deadline) {
    const state = step.state || 'visible';
    const pollMs = step.poll_ms || 500;
    const timeoutMs = Math.min(step.timeout_ms || 30000, remainingMs(deadline, index, step));
    const until = Date.now() + timeoutMs;

    while (Date.now() < until) {
        const res = await sendStep(tabId, { action: 'check', selector: step.selector, pick: step.pick });
        // optional size gate: wait for an actually-large image (skip spinners/placeholders)
        const bigEnough = !step.min_natural_width || (res.naturalWidth || 0) >= step.min_natural_width;
        // optional count gate: wait until >= N elements match (e.g. N attachment previews)
        const countOk = !step.min_count || (res.count || 0) >= step.min_count;
        const satisfied =
            state === 'visible' ? (res.exists && res.visible && bigEnough && countOk) :
            state === 'hidden' ? (!res.exists || !res.visible) :
            state === 'attached' ? res.exists :
            state === 'detached' ? !res.exists :
            null;
        if (satisfied === null) throw new StepError(index, step, `unknown state "${state}"`);
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
        const res = await sendStep(tabId, { action: 'click', selector: step.selector, pick: step.pick });
        if (res.ok) return;
        lastError = res.error;
        // disabled/missing can be transient (React enables the button after input registers)
        if (!res.disabled && !res.missing) throw new StepError(index, step, res.error);
        await sleep(250);
    } while (Date.now() < until);

    throw new StepError(index, step, `${lastError} (after waiting ${waitMs}ms)`);
}

async function navigate(tabId, step, deps) {
    let id = tabId;
    if (id === null) {
        // active:true - synthetic typing via execCommand is unreliable in unfocused documents
        const tab = await chrome.tabs.create({ url: step.url, active: true });
        id = tab.id;
    } else {
        await chrome.tabs.update(id, { url: step.url });
    }
    deps.networkTracker.setTargetUrl(id, step.url);
    await deps.waitForTabLoad(id, false);
    return id;
}

function startHeartbeat(controlUrl, taskId) {
    return setInterval(() => {
        fetch(`${controlUrl}/task_heartbeat/${taskId}`, { method: 'POST' })
            .catch(error => runnerLogger.warn('Heartbeat failed', { taskId, error: error.message }));
    }, HEARTBEAT_INTERVAL_MS);
}

async function submitResult(controlUrl, result) {
    const response = await fetch(`${controlUrl}/submit_task`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ task_id: result.task_id, result })
    });
    const text = await response.text();
    if (!response.ok) {
        throw new Error(`submit_task responded ${response.status}: ${text.substring(0, 200)}`);
    }
    runnerLogger.info('Result submitted', { taskId: result.task_id, status: result.status });
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
    let tabId = null;
    let stepsExecuted = 0;

    runnerLogger.info('Starting interaction task', {
        taskId: task.task_id, steps: steps.length, timeoutSec
    });

    const heartbeat = startHeartbeat(controlUrl, task.task_id);

    try {
        for (let i = 0; i < steps.length; i++) {
            const step = steps[i];
            remainingMs(deadline, i, step);
            runnerLogger.debug(`Step ${i}: ${step.action}`, { selector: step.selector });

            try {
                switch (step.action) {
                    case 'navigate':
                        tabId = await navigate(tabId, step, deps);
                        break;
                    case 'sleep':
                        await sleep(Math.min(step.ms || 1000, remainingMs(deadline, i, step)));
                        break;
                    case 'waitFor':
                        await waitForState(tabId, step, i, deadline);
                        break;
                    case 'waitForStableText':
                        await waitForStableText(tabId, step, i, deadline);
                        break;
                    case 'click':
                        await clickWithEnableWait(tabId, step, i, deadline);
                        break;
                    case 'type':
                    case 'press':
                    case 'uploadFile': {
                        const res = await sendStep(tabId, step);
                        if (!res.ok) throw new StepError(i, step, res.error);
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
                screenshot: screenshot
            }
        };
        await submitResult(controlUrl, result);
        return result;
    } catch (error) {
        runnerLogger.error('Interaction task failed', {
            taskId: task.task_id, error: error.message, stepsExecuted
        });
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
                metadata: { steps_executed: stepsExecuted }
            });
        } catch (submitError) {
            runnerLogger.error('Failed to submit failure result', {
                taskId: task.task_id, error: submitError.message
            });
        }
        throw error;
    } finally {
        clearInterval(heartbeat);
        if (tabId !== null && !params.keep_tab_open) {
            try {
                await chrome.tabs.remove(tabId);
            } catch (closeError) {
                runnerLogger.warn('Failed to close task tab', { tabId, error: closeError.message });
            }
        }
    }
}
