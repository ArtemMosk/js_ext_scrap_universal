// background.js
import UrlSettingsManager from './urlSettingsManager.js';
import Logger from './logger.js';

// Loggers for different components
const logger = new Logger();
const pollLogger = new Logger('POLL');
const initLogger = new Logger('INIT');
const settingsLogger = new Logger('SETTINGS');
const processLogger = new Logger('PROCESS');
const statusLogger = new Logger('STATUS');
const messageLogger = new Logger('MESSAGE');
const tabLogger = new Logger('TAB');

let pollingInterval = null;
let isProcessing = false;
let currentStatus = 'Idle';
let lastPollTime = null;

// Initialize URL Settings Manager
const urlSettingsManager = new UrlSettingsManager(console);

// Define default settings matching your existing ones
const defaultSettings = {
    controlUrl: '',
    pollInterval: 30
};

// Simple logging function without status updates
function log(type, message, data = null) {
    const timestamp = new Date().toISOString();
    const logMessage = `[${timestamp}] ${type}: ${message}`;
    console.log(logMessage);
    if (data) {
        console.log('Additional data:', data);
    }
}

// Direct status setter without logging
function setStatus(status, error = null) {
    currentStatus = status;
    currentError = error;
}

async function fetchWithTimeout(url, options = {}, timeout = 30000) {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeout);
    
    log('FETCH', `Fetching ${url} with timeout ${timeout}ms`);
    try {
        const response = await fetch(url, {
            ...options,
            signal: controller.signal
        });
        clearTimeout(timeoutId);
        log('FETCH', `Received response from ${url}, status: ${response.status}`);
        return response;
    } catch (error) {
        clearTimeout(timeoutId);
        log('FETCH_ERROR', `Error fetching ${url}`, error);
        throw error;
    }
}

async function processUrl(url) {
    const processId = Date.now();
    processLogger.info(`Starting URL processing ${processId}`, { url });
    
    isProcessing = true;
    try {
        processLogger.debug(`Process ${processId}: Creating tab`);
        const tab = await chrome.tabs.create({ url, active: false });
        
        processLogger.debug(`Process ${processId}: Waiting for tab load`);
        await waitForTabLoad(tab.id);
        
        processLogger.debug(`Process ${processId}: Extracting content`);
        const content = await extractContent(tab.id);
        
        processLogger.info(`Process ${processId}: Content extracted`, {
            titleLength: content.title?.length,
            contentLength: content.readableContent?.length
        });
        
        processLogger.debug(`Process ${processId}: Closing tab`);
        await chrome.tabs.remove(tab.id);
        
        processLogger.info(`Process ${processId}: Processing completed successfully`);
    } catch (error) {
        processLogger.error(`Process ${processId} failed`, error);
    } finally {
        isProcessing = false;
    }
}

async function waitForTabLoad(tabId) {
    tabLogger.debug(`Waiting for tab ${tabId} to complete loading`);
    return new Promise((resolve, reject) => {
        const timeout = setTimeout(() => {
            tabLogger.warn(`Tab ${tabId} load timeout`);
            reject(new Error('Tab load timeout'));
        }, 30000);

        chrome.tabs.onUpdated.addListener(function listener(id, info) {
            if (id === tabId && info.status === 'complete') {
                tabLogger.debug(`Tab ${tabId} loaded successfully`);
                clearTimeout(timeout);
                chrome.tabs.onUpdated.removeListener(listener);
                resolve();
            }
        });
    });
}

async function extractContent(tabId) {
    tabLogger.debug(`Extracting content from tab ${tabId}`);
    return new Promise((resolve, reject) => {
        chrome.tabs.sendMessage(tabId, { type: "extract_content" }, response => {
            if (chrome.runtime.lastError) {
                tabLogger.error(`Content extraction failed for tab ${tabId}`, chrome.runtime.lastError);
                reject(chrome.runtime.lastError);
                return;
            }
            tabLogger.debug(`Content extracted successfully from tab ${tabId}`);
            resolve(response.content);
        });
    });
}

async function pollServer(controlUrl) {
    const pollId = Date.now();
    pollLogger.debug(`Starting poll ${pollId}`, { url: controlUrl });
    lastPollTime = Date.now();
    
    try {
        pollLogger.debug(`Poll ${pollId}: Fetching from server`);
        const response = await fetchWithTimeout(`${controlUrl}/get_url`, {}, 30000);
        
        pollLogger.debug(`Poll ${pollId}: Response received`, { 
            status: response.status,
            ok: response.ok 
        });
        
        if (response.status === 204) {
            pollLogger.info(`Poll ${pollId}: No URLs in queue`);
            return;
        }

        if (!response.ok) {
            throw new Error(`HTTP error! status: ${response.status}`);
        }

        const data = await response.json();
        pollLogger.info(`Poll ${pollId}: Received URL`, { url: data.url });

        if (data.url) {
            setStatus(`Processing URL: ${data.url}`);
            await processUrl(data.url);
        }
    } catch (error) {
        pollLogger.error(`Poll ${pollId} failed`, {
            error: error.message,
            stack: error.stack
        });
        throw error;
    }
}

async function initializeExtension() {
    initLogger.info('Extension initialization started');
    
    try {
        const settings = await chrome.storage.sync.get(['controlUrl', 'pollInterval']);
        initLogger.debug('Loaded stored settings', settings);

        initLogger.debug('Initializing UrlSettingsManager');
        urlSettingsManager.onSettingsUpdated = async (newSettings) => {
            settingsLogger.info('Settings updated from URL', newSettings);
            await startPollingWithSettings(newSettings);
        };
        
        initLogger.debug('Checking for existing config tabs');
        await urlSettingsManager.checkConfigTabs();

        if (settings.controlUrl && settings.pollInterval) {
            initLogger.info('Starting polling with stored settings', settings);
            await startPollingWithSettings(settings);
        } else {
            initLogger.info('Waiting for configuration - no stored settings');
        }
        
        initLogger.info('Extension initialization completed');
    } catch (error) {
        initLogger.error('Extension initialization failed', error);
    }
}

async function startPollingWithSettings(settings) {
    settingsLogger.info('Starting polling with settings', settings);
    
    if (!settings.controlUrl || !settings.pollInterval) {
        settingsLogger.warn('Invalid polling settings provided', settings);
        return;
    }
    
    if (pollingInterval) {
        pollLogger.debug('Clearing existing polling interval');
        clearInterval(pollingInterval);
    }
    
    setStatus('Starting polling');
    lastPollTime = Date.now();
    
    try {
        pollLogger.debug('Executing initial poll');
        await pollServer(settings.controlUrl);
    } catch (error) {
        pollLogger.error('Initial poll failed', error);
    }

    pollLogger.info(`Setting up recurring polls every ${settings.pollInterval} seconds`);
    pollingInterval = setInterval(() => {
        if (!isProcessing) {
            pollServer(settings.controlUrl).catch(error => {
                pollLogger.error('Interval poll failed', error);
            });
        } else {
            pollLogger.debug('Skipping poll - processing in progress');
        }
    }, settings.pollInterval * 1000);
}

// Message handling
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
    messageLogger.debug('Message received', { type: request.type, sender: sender.id });
    
    switch (request.type) {
        case 'start_polling':
            messageLogger.info('Start polling requested', request);
            startPollingWithSettings(request).then(() => {
                sendResponse({ status: currentStatus });
            });
            break;
            
        case 'stop_polling':
            messageLogger.info('Stop polling requested');
            if (pollingInterval) {
                clearInterval(pollingInterval);
                pollingInterval = null;
                setStatus('Polling stopped');
            }
            sendResponse({ status: currentStatus });
            break;
            
        case 'get_status':
            messageLogger.debug('Status requested', { currentStatus });
            sendResponse({ status: currentStatus });
            break;
            
        case 'get_logs':
            messageLogger.debug('Logs requested');
            Logger.getLogs().then(logs => {
                sendResponse(logs);
            });
            break;
    }
    
    return true;
});

// Initialize the extension
logger.info('Background script loaded');
initializeExtension().catch(error => {
    logger.error('Fatal initialization error', error);
});