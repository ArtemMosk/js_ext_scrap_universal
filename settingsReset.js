// One background-owned reset transaction. The popup must not delete credentials while a task may
// still need them to submit its terminal result.

const LOCAL_RESET_KEYS = Object.freeze([
    'apiToken',
    'isProcessing',
    'currentStatus',
    'state_processing',
    'lock_processing',
]);
const SESSION_RESET_KEYS = Object.freeze(['reuseTabId', 'reuseContext']);

export async function resetExtensionSettings({ coordinator, journal, localStorage, sessionStorage }) {
    if (!coordinator || typeof coordinator.clear !== 'function') {
        throw new Error('settings reset requires a lifecycle coordinator');
    }
    if (!journal || typeof journal.clear !== 'function') {
        throw new Error('settings reset requires a lifecycle journal');
    }
    if (!localStorage || typeof localStorage.remove !== 'function') {
        throw new Error('settings reset requires local storage');
    }

    // Awaiting the coordinator proves the held poll (or current dispatch) is joined before the bearer
    // token can disappear. The journal's own serialized clear cannot race an earlier append.
    await coordinator.clear('settings-clear');
    await journal.clear();
    await localStorage.remove(LOCAL_RESET_KEYS);
    if (sessionStorage && typeof sessionStorage.remove === 'function') {
        await sessionStorage.remove(SESSION_RESET_KEYS);
    }
}
