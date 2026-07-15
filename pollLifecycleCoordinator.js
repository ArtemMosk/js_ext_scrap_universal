// Chrome lifecycle policy for the polling executor.
//
// PollController owns one actual run. This coordinator owns the desired state derived from durable
// settings and serializes every Chrome event through one reconcile pump. Event handlers never start
// a poll directly, so startup/alarm/settings races cannot create a second owner.

const NOOP_LOGGER = { debug() {}, info() {}, warn() {}, error() {} };
const NOOP_EVENT_SINK = () => {};

export class PollLifecycleCoordinator {
    constructor({
        controller,
        storage,
        alarms,
        alarmName = 'pollServer',
        logger,
        onEvent = NOOP_EVENT_SINK,
        onStatus = () => {},
        defaultPollInterval = 30,
    } = {}) {
        if (!controller || typeof controller.setDesired !== 'function' ||
            typeof controller.whenSettled !== 'function') {
            throw new Error('PollLifecycleCoordinator requires a settle-aware controller');
        }
        if (!storage || typeof storage.get !== 'function' || typeof storage.set !== 'function' ||
            typeof storage.clear !== 'function') {
            throw new Error('PollLifecycleCoordinator requires a storage port');
        }
        if (!alarms || typeof alarms.clear !== 'function' || typeof alarms.create !== 'function') {
            throw new Error('PollLifecycleCoordinator requires an alarms port');
        }
        this._controller = controller;
        this._storage = storage;
        this._alarms = alarms;
        this._alarmName = alarmName;
        this._logger = logger || NOOP_LOGGER;
        this._onEvent = onEvent;
        this._onStatus = onStatus;
        this._defaultPollInterval = defaultPollInterval;

        this._requestedRevision = 0;
        this._appliedRevision = 0;
        this._reconciling = false;
        this._waiters = [];
        this._suspendedForReload = false;
    }

    reconcile(reason = 'event') {
        const revision = ++this._requestedRevision;
        this._emit('reconcile_requested', { reason, revision });
        const completion = new Promise((resolve, reject) => {
            this._waiters.push({ revision, resolve, reject });
        });
        this._kick();
        return completion;
    }

    async start(settings, reason = 'start') {
        const normalized = normalizeSettings({ ...settings, pollingEnabled: true }, this._defaultPollInterval);
        if (!normalized.controlUrl) { throw new Error('polling start requires a valid controlUrl'); }
        await this._storage.set({
            controlUrl: normalized.controlUrl,
            pollInterval: normalized.pollInterval,
            pollingEnabled: true,
        });
        return this.reconcile(reason);
    }

    async stop(reason = 'stop') {
        await this._storage.set({ pollingEnabled: false });
        return this.reconcile(reason);
    }

    async clear(reason = 'clear') {
        await this._storage.clear();
        return this.reconcile(reason);
    }

    // A reload command arrives from inside the current poll dispatch. Waiting for the controller to
    // join here would deadlock that poll on itself. Mark suspension and request stop; the caller acks
    // the command and reloads the worker, while no subsequent event can launch another run first.
    prepareReload(reason = 'reload') {
        this._suspendedForReload = true;
        this._controller.setDesired(null);
        this._emit('reload_prepared', { reason });
    }

    _kick() {
        if (this._reconciling) { return; }
        this._reconciling = true;
        this._drain().catch((error) => {
            this._logger.error('lifecycle reconcile pump failed', { error: safeMessage(error) });
        });
    }

    async _drain() {
        try {
            while (this._appliedRevision < this._requestedRevision) {
                const targetRevision = this._requestedRevision;
                try {
                    const raw = await this._storage.get(['controlUrl', 'pollInterval', 'pollingEnabled']);
                    if (targetRevision !== this._requestedRevision) { continue; }
                    const settings = normalizeSettings(raw, this._defaultPollInterval);
                    await this._apply(settings, targetRevision);
                    this._appliedRevision = targetRevision;
                    this._settleWaiters(targetRevision, null);
                } catch (error) {
                    this._appliedRevision = targetRevision;
                    this._emit('reconcile_failed', { revision: targetRevision, reason: error?.name || 'Error' });
                    this._logger.error('poll lifecycle reconcile failed', { error: safeMessage(error) });
                    this._settleWaiters(targetRevision, error);
                }
            }
        } finally {
            this._reconciling = false;
            if (this._appliedRevision < this._requestedRevision) { this._kick(); }
        }
    }

    async _apply(settings, revision) {
        const enabled = settings.pollingEnabled && !this._suspendedForReload;
        if (!enabled || !settings.controlUrl) {
            await this._alarms.clear(this._alarmName);
            this._controller.setDesired(null);
            await this._controller.whenSettled();
            this._onStatus('Polling stopped');
            this._emit('idle', { revision, reason: this._suspendedForReload ? 'reload' : 'disabled' });
            return;
        }

        const periodInMinutes = Math.max(0.5, settings.pollInterval / 60);
        const existing = typeof this._alarms.get === 'function'
            ? await this._alarms.get(this._alarmName)
            : null;
        if (!existing || existing.periodInMinutes !== periodInMinutes) {
            await this._alarms.clear(this._alarmName);
            this._alarms.create(this._alarmName, { periodInMinutes });
        }
        this._controller.setDesired({ controlUrl: settings.controlUrl });
        await this._controller.whenSettled();
        this._onStatus('Polling');
        this._emit('running', { revision, reason: 'configured' });
    }

    _settleWaiters(revision, error) {
        const pending = [];
        for (const waiter of this._waiters) {
            if (waiter.revision <= revision) {
                if (error) { waiter.reject(error); } else { waiter.resolve(); }
            } else {
                pending.push(waiter);
            }
        }
        this._waiters = pending;
    }

    _emit(event, details = {}) {
        try {
            Promise.resolve(this._onEvent({ event, at: new Date().toISOString(), ...details }))
                .catch((error) => this._logger.warn('lifecycle event sink failed', { error: safeMessage(error) }));
        } catch (error) {
            this._logger.warn('lifecycle event sink failed', { error: safeMessage(error) });
        }
    }
}

function normalizeSettings(raw = {}, defaultPollInterval = 30) {
    const controlUrl = typeof raw.controlUrl === 'string' ? raw.controlUrl.trim() : '';
    const parsedInterval = Number.parseInt(raw.pollInterval, 10);
    const pollInterval = Number.isFinite(parsedInterval) && parsedInterval > 0
        ? parsedInterval
        : defaultPollInterval;
    // Existing profiles predate pollingEnabled. A configured URL is active unless the user has
    // explicitly stopped it; subsequent starts/stops always persist the explicit bit.
    const pollingEnabled = raw.pollingEnabled === undefined
        ? Boolean(controlUrl)
        : raw.pollingEnabled === true;
    return { controlUrl, pollInterval, pollingEnabled };
}

function safeMessage(error) {
    const message = error && typeof error.message === 'string' ? error.message : String(error);
    return message.slice(0, 300);
}
