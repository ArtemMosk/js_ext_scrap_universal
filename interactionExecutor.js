// Interaction step executor - content script counterpart of interactionRunner.js
// Each handler is atomic and fast: all waiting/polling loops live in the background
// script (MV3 service worker stays alive via message activity, and no long-lived
// ports can be severed by a worker restart mid-wait).

function logInteraction(level, message, data = {}) {
    chrome.runtime.sendMessage({
        type: 'content_log',
        level: level,
        message: `[INTERACTION] ${message}`,
        data: data
    });
}

const EXTRACT_ELEMENT_LIMIT = 500000;  // 500KB per element, mirrors contentExtractor.js
const EXTRACT_PAGE_LIMIT = 1000000;    // 1MB for full-page text

function elementArea(el) {
    // prefer intrinsic image size (a generated image is far bigger than icons/avatars)
    const w = el.naturalWidth || el.clientWidth || 0;
    const h = el.naturalHeight || el.clientHeight || 0;
    return w * h;
}

function resolveElements(selector, pick = 'first', excludeWithin = null, minWidth = 0) {
    let nodes = Array.from(document.querySelectorAll(selector));
    // Drop elements inside an excluded ancestor (e.g. the ChatGPT user turn, so an
    // uploaded reference image is never mistaken for the generated image).
    if (excludeWithin) nodes = nodes.filter(n => !n.closest(excludeWithin));
    // Optional size filter so pick 'last'/'first' target only large images (skip avatars),
    // which lets us grab the NEWEST generated image in a reused conversation via pick 'last'.
    if (minWidth) nodes = nodes.filter(n => (n.naturalWidth || n.clientWidth || 0) >= minWidth);
    if (nodes.length === 0) return [];
    switch (pick) {
        case 'last': return [nodes[nodes.length - 1]];
        case 'all': return nodes;
        case 'largest': return [nodes.reduce((a, b) => (elementArea(b) > elementArea(a) ? b : a))];
        case 'first':
        default: return [nodes[0]];
    }
}

function isVisible(el) {
    if (!el) return false;
    if (el.getClientRects().length === 0) return false;
    const style = window.getComputedStyle(el);
    return style.visibility !== 'hidden' && style.display !== 'none';
}

function isDisabled(el) {
    return !!(el.disabled || el.getAttribute('aria-disabled') === 'true');
}

function handleCheck(step) {
    const els = resolveElements(step.selector, step.pick || 'first', step.exclude_within, step.min_natural_width || 0);
    const el = els[0] || null;
    return {
        ok: true,
        exists: !!el,
        count: els.length,
        visible: isVisible(el),
        disabled: el ? isDisabled(el) : null,
        textLength: el ? (el.innerText || '').length : 0,
        textHash: el ? simpleHash(el.innerText || '') : null,
        naturalWidth: el ? (el.naturalWidth || 0) : 0,
        naturalHeight: el ? (el.naturalHeight || 0) : 0,
        src: el ? (el.currentSrc || el.src || el.getAttribute('src') || '') : ''
    };
}

// Cheap content fingerprint so waitForStableText doesn't ship full text every poll
function simpleHash(str) {
    let hash = 0;
    for (let i = 0; i < str.length; i++) {
        hash = ((hash << 5) - hash + str.charCodeAt(i)) | 0;
    }
    return `${str.length}:${hash}`;
}

function setNativeValue(el, text) {
    const proto = el instanceof HTMLTextAreaElement
        ? HTMLTextAreaElement.prototype
        : HTMLInputElement.prototype;
    const setter = Object.getOwnPropertyDescriptor(proto, 'value').set;
    setter.call(el, text);
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
}

function typeIntoContentEditable(el, text, clear) {
    el.focus();
    if (clear) {
        document.execCommand('selectAll', false, null);
    }
    let inserted = document.execCommand('insertText', false, text);
    if (!inserted) {
        // execCommand can fail on some editors; synthesize the input event pair
        const before = new InputEvent('beforeinput', {
            inputType: 'insertText', data: text, bubbles: true, cancelable: true
        });
        const accepted = el.dispatchEvent(before);
        if (accepted) {
            el.textContent = text;
            el.dispatchEvent(new InputEvent('input', {
                inputType: 'insertText', data: text, bubbles: true
            }));
            inserted = true;
        }
    }
    return inserted;
}

function handleType(step) {
    const els = resolveElements(step.selector, step.pick || 'first');
    const el = els[0];
    if (!el) return { ok: false, error: `type: no element matches "${step.selector}"` };

    const method = step.method === 'auto' || !step.method
        ? (el.isContentEditable ? 'contenteditable' : 'value')
        : step.method;

    logInteraction('info', 'Typing into element', {
        selector: step.selector, method: method, textLength: step.text.length
    });

    if (method === 'contenteditable') {
        if (!typeIntoContentEditable(el, step.text, step.clear !== false)) {
            return { ok: false, error: 'type: insertText rejected by editor (execCommand and beforeinput both failed)' };
        }
    } else {
        el.focus();
        setNativeValue(el, step.clear !== false ? step.text : el.value + step.text);
    }
    return { ok: true, method: method };
}

function handleClick(step) {
    const els = resolveElements(step.selector, step.pick || 'first');
    const el = els[0];
    if (!el) return { ok: false, error: `click: no element matches "${step.selector}"`, missing: true };
    if (isDisabled(el)) return { ok: false, disabled: true, error: 'click: element is disabled' };

    el.scrollIntoView({ block: 'center', inline: 'center' });
    const rect = el.getBoundingClientRect();
    const opts = {
        bubbles: true, cancelable: true, view: window,
        clientX: rect.left + rect.width / 2,
        clientY: rect.top + rect.height / 2,
        button: 0
    };
    // Full pointer sequence: React handlers often listen on pointer/mouse down, not click
    el.dispatchEvent(new PointerEvent('pointerdown', opts));
    el.dispatchEvent(new MouseEvent('mousedown', opts));
    el.dispatchEvent(new PointerEvent('pointerup', opts));
    el.dispatchEvent(new MouseEvent('mouseup', opts));
    el.click();
    logInteraction('info', 'Clicked element', { selector: step.selector });
    return { ok: true };
}

function handlePress(step) {
    const els = step.selector ? resolveElements(step.selector, step.pick || 'first') : [document.activeElement];
    const el = els[0];
    if (!el) return { ok: false, error: `press: no element matches "${step.selector}"` };

    const key = step.key || 'Enter';
    const keyCode = key === 'Enter' ? 13 : key.charCodeAt(0);
    const opts = { key: key, code: key, keyCode: keyCode, which: keyCode, bubbles: true, cancelable: true };
    el.focus();
    el.dispatchEvent(new KeyboardEvent('keydown', opts));
    el.dispatchEvent(new KeyboardEvent('keypress', opts));
    el.dispatchEvent(new KeyboardEvent('keyup', opts));
    return { ok: true };
}

function handleExtract(step) {
    if (!step.selector) {
        return {
            ok: true,
            data: {
                title: document.title,
                url: window.location.href,
                text: (document.body.innerText || '').substring(0, EXTRACT_PAGE_LIMIT).trim()
            }
        };
    }
    const els = resolveElements(step.selector, step.pick || 'first');
    if (els.length === 0) return { ok: false, error: `extract: no element matches "${step.selector}"` };

    const attribute = step.attribute || 'innerText';
    const values = els.map(el => {
        const raw = attribute === 'innerText' ? el.innerText
            : attribute === 'innerHTML' ? el.innerHTML
            : el.getAttribute(attribute);
        return (raw || '').substring(0, EXTRACT_ELEMENT_LIMIT).trim();
    });
    return {
        ok: true,
        data: {
            url: window.location.href,
            text: step.pick === 'all' ? values.join('\n\n---\n\n') : values[0]
        }
    };
}

const EXTRACT_IMAGE_MAX_BYTES = 20 * 1024 * 1024; // 20MB cap for a single image

function blobToDataURL(blob) {
    return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(reader.result);
        reader.onerror = () => reject(new Error('FileReader failed'));
        reader.readAsDataURL(blob);
    });
}

// Extract a rendered image's actual bytes as a base64 data URL.
// Primary path: fetch in the page context (same-origin / CORS-ok — e.g. ChatGPT's
// generated images, verified to work). On a cross-origin/CORS failure, return
// src_url + a flag so interactionRunner.js re-fetches from the background service
// worker (host_permissions bypass CORS there).
async function handleExtractImage(step) {
    // ChatGPT streams a generated image in progressively (a short-lived preview appears, then the
    // final image replaces it ~60-90s later). Polling for the FIRST match grabs the preview, which
    // is then gone by fetch time. So poll up to wait_ms for a matching IMG whose src has been
    // STABLE for stable_ms — that's the finished image, not a transient preview.
    const waitMs = step.wait_ms || 12000;
    const stableMs = step.stable_ms || 0;
    const minW = step.min_natural_width || 0;
    const until = Date.now() + waitMs;
    let el = null, lastSrc = null, stableSince = 0;
    while (true) {
        const els = resolveElements(step.selector, step.pick || 'last', step.exclude_within, minW);
        const cand = els.find(e => e.tagName === 'IMG') || els[0] || null;
        const src0 = cand && (cand.currentSrc || cand.src || cand.getAttribute('src'));
        const bigEnough = !!(cand && src0 && (cand.naturalWidth || 0) >= minW);
        if (bigEnough) {
            if (src0 === lastSrc) {
                if (!stableMs || (Date.now() - stableSince) >= stableMs) { el = cand; break; }
            } else { lastSrc = src0; stableSince = Date.now(); }
        } else { lastSrc = null; }
        if (Date.now() >= until) { if (bigEnough) el = cand; break; }  // accept best candidate at timeout
        await new Promise(r => setTimeout(r, 700));
    }
    if (!el) return { ok: false, error: `extractImage: no stable element matches "${step.selector}" (>=${minW}px) within ${waitMs}ms` };
    const src = el.currentSrc || el.src || el.getAttribute('src');
    if (!src) return { ok: false, error: 'extractImage: element has no src' };

    const meta = {
        image: true,
        src_url: src,
        width: el.naturalWidth || null,
        height: el.naturalHeight || null,
        url: window.location.href
    };

    try {
        const resp = await fetch(src);
        if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
        const blob = await resp.blob();
        if (blob.size > EXTRACT_IMAGE_MAX_BYTES) {
            return { ok: false, error: `extractImage: ${blob.size}B exceeds ${EXTRACT_IMAGE_MAX_BYTES}B cap` };
        }
        const dataUrl = await blobToDataURL(blob);
        return { ok: true, data: { ...meta, mime: blob.type, bytes: blob.size, dataUrl } };
    } catch (fetchErr) {
        logInteraction('warn', 'extractImage in-page fetch failed; deferring to background', {
            src: src.slice(0, 80), error: fetchErr.message
        });
        return { ok: true, data: { ...meta, dataUrl: null, needsBackgroundFetch: true } };
    }
}

const UPLOAD_VERIFY_TIMEOUT_MS = 15000;

function dataUrlToFile(dataUrl, name) {
    const m = /^data:([^;,]*)[^,]*,(.*)$/s.exec(dataUrl || '');
    if (!m) throw new Error('malformed data_url');
    const mime = m[1] || 'image/png';
    const bin = atob(m[2]);
    const arr = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
    return new File([arr], name || 'ref.png', { type: mime });
}

// Count independent signals that an attachment actually rendered in the composer.
// Multi-signal so we don't depend on one fragile ChatGPT class/testid.
function attachmentSignals(baselineBlobImgs) {
    return {
        blobImgsDelta: document.querySelectorAll('img[src^="blob:"]').length - baselineBlobImgs,
        attachTestids: document.querySelectorAll('[data-testid*="attachment" i], [data-testid*="file-upload" i]').length,
        removeBtns: document.querySelectorAll('button[aria-label*="remove" i], button[aria-label*="delete file" i]').length
    };
}

// Upload reference image(s) into a file <input> via DataTransfer (the same mechanism
// Playwright's setInputFiles uses), then VERIFY the attachment previews appear.
// Returns ok:false (fail-loud) if nothing attaches, with the raw signal counts so the
// caller/server can diagnose without a live DOM probe.
async function handleUploadFile(step) {
    const inputs = Array.from(document.querySelectorAll(step.selector || 'input[type="file"]'));
    const input = inputs.find(i => (i.getAttribute('accept') || '').includes('image')) || inputs[inputs.length - 1];
    if (!input) return { ok: false, error: `uploadFile: no file input matches "${step.selector || 'input[type=file]'}"` };
    if (!Array.isArray(step.files) || step.files.length === 0) return { ok: false, error: 'uploadFile: no files provided' };

    const baseline = document.querySelectorAll('img[src^="blob:"]').length;
    const dt = new DataTransfer();
    for (let i = 0; i < step.files.length; i++) {
        try {
            dt.items.add(dataUrlToFile(step.files[i].data_url, step.files[i].name || `ref_${i}.png`));
        } catch (e) {
            return { ok: false, error: `uploadFile: file ${i} decode failed: ${e.message}` };
        }
    }
    const n = dt.files.length;
    try {
        input.files = dt.files;
    } catch (e) {
        return { ok: false, error: `uploadFile: cannot set files on input: ${e.message}` };
    }
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new Event('change', { bubbles: true }));

    const until = Date.now() + (step.verify_timeout_ms || UPLOAD_VERIFY_TIMEOUT_MS);
    let sig = attachmentSignals(baseline);
    while (Date.now() < until) {
        sig = attachmentSignals(baseline);
        if (sig.blobImgsDelta >= n || sig.attachTestids >= n || sig.removeBtns >= n) {
            logInteraction('info', 'uploadFile verified', { attached: n, signals: sig });
            return { ok: true, attached: n, verified: true, signals: sig };
        }
        await new Promise(r => setTimeout(r, 400));
    }
    return {
        ok: false, attached: n, verified: false, signals: sig,
        error: `uploadFile: attachments not confirmed (attached ${n}, signals ${JSON.stringify(sig)})`
    };
}

// Diagnostic: dump the page's images (size, src scheme/head, which turn) + composer state.
// Returned as JSON text so the server/caller can see ChatGPT's real DOM without CDP.
function handleProbe(step) {
    const imgs = Array.from(document.querySelectorAll('img')).map(i => ({
        w: i.naturalWidth, h: i.naturalHeight,
        scheme: (i.currentSrc || i.src || '').split(':')[0],
        head: (i.currentSrc || i.src || '').slice(0, 70),
        assistant: !!i.closest('[data-message-author-role="assistant"]'),
        user: !!i.closest('[data-message-author-role="user"]')
    }));
    const fileInputs = Array.from(document.querySelectorAll('input[type="file"]'))
        .map(i => ({ accept: i.getAttribute('accept'), files: i.files ? i.files.length : 0 }));
    return { ok: true, data: { text: JSON.stringify({
        url: location.href,
        stopButton: !!document.querySelector('button[data-testid="stop-button"]'),
        sendDisabled: (() => { const b = document.querySelector('#composer-submit-button, button[data-testid="send-button"]'); return b ? (b.disabled || b.getAttribute('aria-disabled')) : 'no-send-btn'; })(),
        fileInputs, imgs
    }) } };
}

// Detect ChatGPT's rate-limit banners so we can back off instead of hammering the account (ban
// risk). Only SPECIFIC ChatGPT phrases — no broad "rate limit"/"too many requests" that could
// match incidental page text and false-trip a cooldown. Returns the matched text as evidence.
const RATE_LIMIT_PATTERNS = [
    /making requests too quickly/i,
    /temporarily limited access to your conversations/i,
    /you['’]?re sending messages too (fast|quickly)/i,
    /please wait a few minutes before trying again/i,
    /you['’]?ve reached (your|the).{0,25}(message|image|usage|plan) limit/i
];
function handleCheckRateLimit() {
    const text = ((document.body && document.body.innerText) || '').slice(0, 8000);
    for (const re of RATE_LIMIT_PATTERNS) {
        const m = text.match(re);
        if (m) {
            const i = (m.index != null) ? m.index : text.indexOf(m[0]);
            const snippet = text.slice(Math.max(0, i - 30), i + 140).replace(/\s+/g, ' ').trim();
            return { ok: false, error: `CHATGPT_RATE_LIMITED: ${snippet}`, rate_limited: true, matched: re.source, snippet };
        }
    }
    return { ok: true, rate_limited: false };
}

async function dispatchStep(step) {
    switch (step.action) {
        case 'check':          return handleCheck(step);
        case 'type':           return handleType(step);
        case 'click':          return handleClick(step);
        case 'press':          return handlePress(step);
        case 'extract':        return handleExtract(step);
        case 'extractImage':   return await handleExtractImage(step);
        case 'uploadFile':     return await handleUploadFile(step);
        case 'probe':          return handleProbe(step);
        case 'checkRateLimit': return handleCheckRateLimit();
        default:               return { ok: false, error: `Unknown interaction action: ${step.action}` };
    }
}

chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
    if (request.type !== 'interaction_step' || !request.step) return false;
    const step = request.step;
    Promise.resolve()
        .then(() => dispatchStep(step))
        .then(sendResponse)
        .catch(error => {
            logInteraction('error', 'Interaction step failed', {
                action: step.action, selector: step.selector, error: error.message
            });
            sendResponse({ ok: false, error: `${step.action}: ${error.message}` });
        });
    return true; // keep the message channel open for the async response
});
