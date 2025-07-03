// background.js
import UrlSettingsManager from './urlSettingsManager.js';
import Logger from './logger.js';
import NetworkRequestTracker from './networkRequestTracker.js';
import ScreenshotCapture from './backgroundScreenshotHandler.js';

// Loggers for different components
const logger = new Logger();
const pollLogger = new Logger('POLL');
const initLogger = new Logger('INIT');
const settingsLogger = new Logger('SETTINGS');
const processLogger = new Logger('PROCESS');
const statusLogger = new Logger('STATUS');
const messageLogger = new Logger('MESSAGE');
const tabLogger = new Logger('TAB');
const fetchLogger = new Logger('FETCH');

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

// Direct status setter without logging
function setStatus(status) {
    statusLogger.info('Status changing', { from: currentStatus, to: status });
    currentStatus = status;
}

async function fetchWithTimeout(url, options = {}, timeout = 5000) {
    const controller = new AbortController();
    const id = Date.now();
    
    const timeoutId = setTimeout(() => {
        fetchLogger.debug(`Request ${id} timed out after ${timeout}ms`, { url });
        controller.abort();
    }, timeout);

    try {
        fetchLogger.debug(`Starting request ${id}`, { url, timeout });
        const response = await fetch(url, {
            ...options,
            signal: controller.signal
        });
        fetchLogger.debug(`Request ${id} completed`, { 
            status: response.status,
            ok: response.ok 
        });
        return response;
    } catch (error) {
        if (error.name === 'AbortError') {
            fetchLogger.debug(`Request ${id} aborted`, { url });
        } else {
            fetchLogger.error(`Request ${id} failed`, { 
                url, 
                error: error.message 
            });
        }
        throw error;
    } finally {
        clearTimeout(timeoutId);
    }
}

async function processUrl(url, controlUrl) {
    const processId = Date.now();
    processLogger.info(`Starting URL processing ${processId}`, { url });
    
    isProcessing = true;
    let tab = null;
    let formattedContent = null;
    
    try {
        processLogger.debug(`Process ${processId}: Creating tab`);
        tab = await chrome.tabs.create({ url, active: true });
        
        // Set target URL before waiting for network idle
        networkTracker.setTargetUrl(tab.id, url);
        
        processLogger.debug(`Process ${processId}: Waiting for tab load and security checks`);
        await waitForTabLoad(tab.id);
        
        processLogger.debug(`Process ${processId}: Extracting content`);
        const extractedContent = await extractContent(tab.id);
        
        // Wait additional time for any dynamic content
        await new Promise(resolve => setTimeout(resolve, 2000));
        
        processLogger.debug(`Process ${processId}: Capturing full page screenshot`);
        const screenshotCapture = new ScreenshotCapture();
        const screenshot = await screenshotCapture.captureFullPage(tab.id);
        
        // Format the content according to server's expected schema
        formattedContent = {
            url: url,
            transformedUrl: extractedContent.url,
            content: {
                rawHtml: extractedContent.rawHtml,
                rawPurifiedContent: extractedContent.rawPurifiedContent,
                readableContent: extractedContent.readableContent,
                title: extractedContent.title,
                screenshot: screenshot
            }
        };

        // Log preview of content
        processLogger.info(`Process ${processId}: Content preview`, {
            originalUrl: formattedContent.url,
            transformedUrl: formattedContent.transformedUrl,
            titleLength: formattedContent.content.title?.length,
            contentLength: formattedContent.content.readableContent?.length,
            screenshotSize: formattedContent.content.screenshot?.length,
            contentPreview: formattedContent.content.readableContent?.substring(0, 100)
        });

        // Send to server with detailed logging
        try {
            processLogger.debug(`Process ${processId}: Sending to server`, {
                endpoint: controlUrl,
                contentSize: JSON.stringify(formattedContent).length
            });

            const response = await fetch(controlUrl + '/submit', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                },
                body: JSON.stringify(formattedContent)
            });

            const responseData = await response.text();
            processLogger.info(`Process ${processId}: Server response`, {
                status: response.status,
                responsePreview: responseData.substring(0, 100)
            });

            if (!response.ok) {
                throw new Error(`Server responded with ${response.status}: ${responseData}`);
            }
        } catch (serverError) {
            processLogger.error(`Process ${processId}: Server communication failed`, serverError);
            throw serverError;
        }
        
        processLogger.info(`Process ${processId}: Processing completed successfully`);
    } catch (error) {
        processLogger.error(`Process ${processId} failed`, error);
        throw error;
    } finally {
        if (tab) {
            processLogger.debug(`Process ${processId}: Closing tab`);
            await chrome.tabs.remove(tab.id).catch(e => 
                processLogger.error(`Failed to close tab`, e)
            );
        }
        isProcessing = false;
    }
    
    return formattedContent;
}

const networkTracker = new NetworkRequestTracker();
const screenshotCapture = new ScreenshotCapture();

async function waitForTabLoad(tabId) {
    return new Promise((resolve, reject) => {
        chrome.tabs.onUpdated.addListener(function listener(id, info) {
            if (id === tabId && info.status === 'complete') {
                chrome.tabs.onUpdated.removeListener(listener);
                
                // Increased timeout and added ignoreScreenshotCapture option
                networkTracker.waitForNetworkIdle(tabId, {
                    timeout: 45000,        // Increase to 45 seconds
                    quietPeriod: 2000,     // Reduce to 2 seconds
                    checkInterval: 100,
                    ignoreScreenshotCapture: true,
                    maxActiveRequests: 2   // New: allow up to 2 active requests
                })
                .then(resolve)
                .catch(reject);
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
            pollLogger.debug(`Poll ${pollId}: No URLs in queue`);
            return;
        }

        if (!response.ok) {
            throw new Error(`HTTP error! status: ${response.status}`);
        }

        const data = await response.json();
        pollLogger.info(`Poll ${pollId}: Received URL`, { url: data.url });

        if (data.url) {
            setStatus(`Processing URL: ${data.url}`);
            await processUrl(data.url, controlUrl);
        }
    } catch (error) {
        if (error.name === 'AbortError') {
            pollLogger.debug(`Poll ${pollId}: Request timeout - normal during idle periods`);
        } else {
            pollLogger.error(`Poll ${pollId} failed`, {
                error: error.message,
                stack: error.stack
            });
        }
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