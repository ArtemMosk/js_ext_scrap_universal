export default class Logger {
    constructor(prefix = '') {
        this.prefix = prefix;
        this.defaultGraylogEndpoint = 'https://gelf.pt.artemm.info/gelf';
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
        this._sendToGraylog(level, message, data, location);
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

    async _sendToGraylog(level, message, data, location) {
        try {
            // Get Graylog endpoint from settings
            const { graylogEndpoint = this.defaultGraylogEndpoint } = await chrome.storage.sync.get('graylogEndpoint');
            
            if (!graylogEndpoint) {
                return; // No endpoint configured, skip logging
            }

            const gelfMessage = {
                version: '1.1',
                host: 'browser_extension',
                short_message: message,
                full_message: data ? JSON.stringify(data) : message,
                timestamp: Date.now() / 1000,
                level: this._getGelfLevel(level),
                facility: 'js_ext_scrap_universal',
                _prefix: this.prefix,
                _location: location,
                _data: data ? JSON.stringify(data) : null
            };

            await fetch(graylogEndpoint, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                },
                body: JSON.stringify(gelfMessage)
            });
        } catch (error) {
            // Silently fail to avoid logging loops
            console.warn('Failed to send log to Graylog:', error.message);
        }
    }

    _getGelfLevel(level) {
        switch (level) {
            case 'debug': return 7;
            case 'info': return 6;
            case 'warn': return 4;
            case 'error': return 3;
            default: return 6;
        }
    }
} 