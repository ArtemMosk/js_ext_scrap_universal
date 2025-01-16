export default class Logger {
    constructor(prefix = '') {
        this.prefix = prefix;
        
        // Bind console methods while preserving call stack
        this._debug = console.debug.bind(console);
        this._info = console.info.bind(console);
        this._warn = console.warn.bind(console);
        this._error = console.error.bind(console);
    }

    formatMessage(message, data = null) {
        const timestamp = new Date().toISOString();
        const prefix = this.prefix ? ` [${this.prefix}]` : '';
        return [`[${timestamp}]${prefix} ${message}`, data].filter(Boolean);
    }

    async _saveLog(level, message, data) {
        const logEntry = {
            timestamp: new Date().toISOString(),
            level,
            prefix: this.prefix,
            message,
            data
        };

        // Get existing logs
        const { debugLogs = [] } = await chrome.storage.local.get('debugLogs');
        
        // Add new log and keep last 1000 entries
        debugLogs.push(logEntry);
        if (debugLogs.length > 1000) {
            debugLogs.shift();
        }

        // Save back to storage
        await chrome.storage.local.set({ debugLogs });
    }

    debug(message, data = null) {
        this._debug(...this.formatMessage(message, data));
        this._saveLog('DEBUG', message, data);
    }

    info(message, data = null) {
        this._info(...this.formatMessage(message, data));
        this._saveLog('INFO', message, data);
    }

    warn(message, data = null) {
        this._warn(...this.formatMessage(message, data));
        this._saveLog('WARN', message, data);
    }

    error(message, data = null) {
        this._error(...this.formatMessage(message, data));
        this._saveLog('ERROR', message, data);
    }

    static async getLogs() {
        const { debugLogs = [] } = await chrome.storage.local.get('debugLogs');
        return debugLogs;
    }

    static async clearLogs() {
        await chrome.storage.local.remove('debugLogs');
    }
} 