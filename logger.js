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

    debug(message, data = null) {
        this._debug(...this.formatMessage(message, data));
    }

    info(message, data = null) {
        this._info(...this.formatMessage(message, data));
    }

    warn(message, data = null) {
        this._warn(...this.formatMessage(message, data));
    }

    error(message, data = null) {
        this._error(...this.formatMessage(message, data));
    }

    static getLogs() {
        return new Promise((resolve) => {
            chrome.storage.local.get(['debugLogs'], result => {
                resolve(result.debugLogs || []);
            });
        });
    }

    static clearLogs() {
        return new Promise((resolve) => {
            chrome.storage.local.remove(['debugLogs'], resolve);
        });
    }
} 