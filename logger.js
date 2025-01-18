export default class Logger {
    constructor(prefix = '') {
        this.prefix = prefix;
    }

    _log(level, message, data = null) {
        const timestamp = new Date().toISOString();
        const prefix = this.prefix ? ` [${this.prefix}]` : '';
        
        // Get the caller's stack trace
        const stack = new Error().stack.split('\n')[3];
        const fileInfo = stack.match(/at .+ \((.+)\)/) || stack.match(/at (.+)/);
        const location = fileInfo ? fileInfo[1] : 'unknown';

        console[level](`${timestamp}${prefix} ${message} ${location ? `(${location})` : ''}`, data || '');
        this._saveLog(level, message, data, location);
    }

    debug(message, data = null) {
        this._log('debug', message, data);
    }

    info(message, data = null) {
        this._log('info', message, data);
    }

    warn(message, data = null) {
        this._log('warn', message, data);
    }

    error(message, data = null) {
        this._log('error', message, data);
    }

    async _saveLog(level, message, data, location) {
        const logEntry = {
            timestamp: new Date().toISOString(),
            level,
            prefix: this.prefix,
            message,
            data,
            location
        };

        const { debugLogs = [] } = await chrome.storage.local.get('debugLogs');
        debugLogs.push(logEntry);
        if (debugLogs.length > 1000) debugLogs.shift();
        await chrome.storage.local.set({ debugLogs });
    }

    static async getLogs() {
        const { debugLogs = [] } = await chrome.storage.local.get('debugLogs');
        return debugLogs;
    }

    static async clearLogs() {
        await chrome.storage.local.remove('debugLogs');
    }
} 