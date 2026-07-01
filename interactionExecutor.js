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

function resolveElements(selector, pick = 'first') {
    const nodes = Array.from(document.querySelectorAll(selector));
    if (nodes.length === 0) return [];
    switch (pick) {
        case 'last': return [nodes[nodes.length - 1]];
        case 'all': return nodes;
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
    const els = resolveElements(step.selector, step.pick || 'first');
    const el = els[0] || null;
    return {
        ok: true,
        exists: !!el,
        count: document.querySelectorAll(step.selector).length,
        visible: isVisible(el),
        disabled: el ? isDisabled(el) : null,
        textLength: el ? (el.innerText || '').length : 0,
        textHash: el ? simpleHash(el.innerText || '') : null
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
    const els = resolveElements(step.selector, step.pick || 'last');
    const el = els.find(e => e.tagName === 'IMG') || els[0];
    if (!el) return { ok: false, error: `extractImage: no element matches "${step.selector}"` };
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

async function dispatchStep(step) {
    switch (step.action) {
        case 'check':        return handleCheck(step);
        case 'type':         return handleType(step);
        case 'click':        return handleClick(step);
        case 'press':        return handlePress(step);
        case 'extract':      return handleExtract(step);
        case 'extractImage': return await handleExtractImage(step);
        default:             return { ok: false, error: `Unknown interaction action: ${step.action}` };
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
