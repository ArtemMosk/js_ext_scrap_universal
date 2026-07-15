// Bounded, privacy-safe lifecycle evidence. This adapter owns Chrome storage; control modules only
// emit events. Writes are ordered and detached from control; the optional size probe is bounded.

const ALLOWED_TEXT = new Set(['event', 'reason', 'at']);
const ALLOWED_NUMBER = new Set(['generation', 'revision', 'storageBytes']);

export class LifecycleJournal {
    constructor({
        storage,
        key = 'pollLifecycleJournal',
        maxEntries = 200,
        operationTimeoutMs = 1000,
        sessionId = makeSessionId(),
        logger = { warn() {} },
    } = {}) {
        if (!storage || typeof storage.get !== 'function' || typeof storage.set !== 'function') {
            throw new Error('LifecycleJournal requires a storage port');
        }
        this._storage = storage;
        this._key = key;
        this._maxEntries = maxEntries;
        this._operationTimeoutMs = operationTimeoutMs;
        this._sessionId = String(sessionId).slice(0, 80);
        this._logger = logger;
        this._tail = Promise.resolve();
    }

    append(eventOrRecord, details = {}) {
        const raw = typeof eventOrRecord === 'string'
            ? { event: eventOrRecord, ...details }
            : { ...(eventOrRecord || {}) };
        const record = sanitizeRecord(raw, this._sessionId);
        const write = () => this._write(record);
        this._tail = this._tail.then(write, write).catch((error) => {
            this._logger.warn('lifecycle journal write failed', { error: safeMessage(error) });
        });
        return this._tail;
    }

    clear() {
        const remove = typeof this._storage.remove === 'function'
            ? () => this._storage.remove(this._key)
            : () => this._storage.set({ [this._key]: [] });
        this._tail = this._tail.then(remove, remove);
        return this._tail;
    }

    async _write(record) {
        // Keep writes serialized even if Chrome storage is slow. Timing a non-abortable set() out and
        // starting a later write would let the old write complete last and overwrite newer evidence.
        // A hung journal tail is acceptable because append() is detached from lifecycle control.
        const current = await this._storage.get(this._key);
        const entries = Array.isArray(current?.[this._key]) ? current[this._key].slice() : [];
        if (typeof this._storage.getBytesInUse === 'function') {
            try {
                const bytes = await bounded(this._storage.getBytesInUse(null), this._operationTimeoutMs);
                if (Number.isFinite(bytes)) { record.storageBytes = bytes; }
            } catch (_) { /* bytes are optional evidence */ }
        }
        entries.push(record);
        await this._storage.set({ [this._key]: entries.slice(-this._maxEntries) });
    }
}

function sanitizeRecord(raw, sessionId) {
    const record = { sessionId, event: 'unknown', at: new Date().toISOString() };
    for (const [key, value] of Object.entries(raw)) {
        if (ALLOWED_TEXT.has(key) && typeof value === 'string') {
            record[key] = value.slice(0, 160);
        } else if (ALLOWED_NUMBER.has(key) && Number.isFinite(value)) {
            record[key] = value;
        }
    }
    return record;
}

function bounded(promise, timeoutMs) {
    let timer;
    return Promise.race([
        Promise.resolve(promise),
        new Promise((_, reject) => {
            timer = setTimeout(() => reject(new Error('journal storage operation timed out')), timeoutMs);
        }),
    ]).finally(() => clearTimeout(timer));
}

function makeSessionId() {
    return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

function safeMessage(error) {
    return (error && error.message ? String(error.message) : String(error)).slice(0, 300);
}
