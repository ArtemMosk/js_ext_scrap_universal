// urlSettingsManager.js

import Logger from './logger.js';

export default class UrlSettingsManager {
    constructor() {
        this.logger = new Logger('URL_SETTINGS');
        this.onSettingsUpdated = null;
        this.logger.debug('UrlSettingsManager initialized');
    }

    /**
     * Add keys that should always be treated as arrays
     * @param {string[]} keys - Array of keys to be treated as arrays
     */
    addArrayKeys(keys) {
        this.arrayKeys = [...new Set([...this.arrayKeys, ...keys])];
    }

    /**
     * Check if URL is a configuration URL
     * @param {string} url - URL to check
     * @returns {boolean}
     */
    isConfigUrl(url) {
        if (!url) return false;
        try {
            // Properly handle URLs with unescaped parameters
            const urlObj = new URL(decodeURIComponent(url));
            const isConfig = urlObj.hostname === 'ext-config.com';
            if (isConfig) {
                this.logger.debug('Found config URL', { url: urlObj.toString() });
            }
            return isConfig;
        } catch (error) {
            this.logger.warn('Failed to parse URL', { url, error: error.message });
            return false;
        }
    }

    /**
     * Update settings from URL parameters
     * @param {string} url - URL containing settings
     * @param {Object} defaultSettings - Default settings to use
     */
    async updateSettingsFromUrl(url, defaultSettings = {}) {
        this.logger.info('Updating settings from URL', { url, defaultSettings });
        
        try {
            // First decode the URL to handle any encoded characters
            const decodedUrl = decodeURIComponent(url);
            const urlObj = new URL(decodedUrl);
            
            // Get the actual control URL from the parameters
            const controlUrl = urlObj.searchParams.get('controlUrl') || 
                             urlObj.searchParams.get('control_url') || 
                             defaultSettings.controlUrl;
            
            const pollInterval = parseInt(urlObj.searchParams.get('pollInterval') || 
                                       urlObj.searchParams.get('poll_interval')) || 
                               defaultSettings.pollInterval;

            const graylogEndpoint = urlObj.searchParams.get('graylogEndpoint') || 
                                  urlObj.searchParams.get('graylog_endpoint') || 
                                  defaultSettings.graylogEndpoint;

            const newSettings = { controlUrl, pollInterval, graylogEndpoint };

            this.logger.debug('Parsed settings from URL', { newSettings });

            const currentSettings = await this.getStorageSync(defaultSettings);
            this.logger.debug('Current settings', { currentSettings });

            if (this.settingsChanged(currentSettings, newSettings)) {
                this.logger.info(`Set controlUrl to ${newSettings.controlUrl}`);
                this.logger.info(`Set pollInterval to ${newSettings.pollInterval}`);
                
                await this.setStorageSync(newSettings);
                this.logger.info('Updated settings with values loaded from ext-config.com URL');
                
                if (this.onSettingsUpdated) {
                    this.logger.debug('Calling onSettingsUpdated callback', { newSettings });
                    await this.onSettingsUpdated(newSettings);
                } else {
                    this.logger.debug('No onSettingsUpdated callback registered');
                }
            } else {
                this.logger.debug('Settings unchanged, skipping update');
            }
        } catch (error) {
            this.logger.error('Error updating settings from URL', { error: error.message, stack: error.stack });
            throw error; // Re-throw to allow upstream error handling
        }
    }

    /**
     * Helper method to get chrome storage sync data
     * @param {Object} defaults - Default settings
     * @returns {Promise}
     */
    getStorageSync(defaults) {
        this.logger.debug('Getting storage sync data', { defaults });
        return new Promise((resolve) => {
            chrome.storage.sync.get(defaults, (result) => {
                this.logger.debug('Retrieved storage sync data', { result });
                resolve(result);
            });
        });
    }

    /**
     * Helper method to set chrome storage sync data
     * @param {Object} data - Data to store
     * @returns {Promise}
     */
    setStorageSync(data) {
        this.logger.debug('Setting storage sync data', { data });
        return new Promise((resolve) => {
            chrome.storage.sync.set(data, () => {
                this.logger.debug('Storage sync data set successfully');
                resolve();
            });
        });
    }

    /**
     * Compare old and new settings
     * @param {Object} oldSettings - Current settings
     * @param {Object} newSettings - New settings
     * @returns {boolean}
     */
    settingsChanged(oldSettings, newSettings) {
        const changed = oldSettings.controlUrl !== newSettings.controlUrl || 
                       oldSettings.pollInterval !== newSettings.pollInterval;
        
        this.logger.debug('Checking if settings changed', {
            oldSettings,
            newSettings,
            changed
        });
        
        return changed;
    }

    /**
     * Check all tabs for configuration URLs
     */
    async checkConfigTabs() {
        this.logger.info('Checking all tabs for config URLs');
        try {
            const tabs = await this.queryTabs({});
            this.logger.debug('Retrieved tabs', { count: tabs.length });

            for (const tab of tabs) {
                this.logger.debug('Checking tab', { tabId: tab.id, url: tab.url });
                if (this.isConfigUrl(tab.url)) {
                    this.logger.info('Found config URL in tab', { tabId: tab.id, url: tab.url });
                    await this.updateSettingsFromUrl(tab.url, {});
                }
            }
            this.logger.info('Completed checking all tabs');
        } catch (error) {
            this.logger.error('Error checking config tabs', { error: error.message, stack: error.stack });
            throw error;
        }
    }

    /**
     * Helper method to query tabs
     * @param {Object} queryInfo - Query parameters
     * @returns {Promise}
     */
    queryTabs(queryInfo) {
        this.logger.debug('Querying tabs', { queryInfo });
        return new Promise((resolve) => {
            chrome.tabs.query(queryInfo, (tabs) => {
                this.logger.debug('Tab query completed', { tabCount: tabs.length });
                resolve(tabs);
            });
        });
    }

    /**
     * Initialize tab listeners
     * @param {Object} defaultSettings - Default settings to use
     */
    initializeTabListeners(defaultSettings = {}) {
        this.logger.info('Initializing tab listeners', { defaultSettings });
        
        chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
            this.logger.debug('Tab updated', { tabId, changeInfo, url: tab.url });
            
            if (changeInfo.status === 'complete' && this.isConfigUrl(tab.url)) {
                this.logger.info('Config URL loaded in tab', { tabId, url: tab.url });
                this.updateSettingsFromUrl(tab.url, defaultSettings);
            }
        });
        
        this.logger.info('Tab listeners initialized');
    }
}