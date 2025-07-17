// background.js
import UrlSettingsManager from './urlSettingsManager.js';
import Logger from './logger.js';
import NetworkRequestTracker from './networkRequestTracker.js';
import ScreenshotCapture from './backgroundScreenshotHandler.js';
import { StateLock } from './stateLock.js';

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
const lockLogger = new Logger('LOCK');

// Initialize StateLock
const stateLock = new StateLock(lockLogger);

// Alarm-based polling (replaces setInterval)
const ALARM_NAME = 'pollServer';
let pollingInterval = null; // Keep for compatibility, but will be null with alarms
let isProcessing = false;
let currentStatus = 'Idle';
let lastPollTime = null;

// Continuous polling state
let isContinuousPolling = false;

// Initialize URL Settings Manager
const urlSettingsManager = new UrlSettingsManager(console);

// Define default settings matching your existing ones
const defaultSettings = {
    controlUrl: '',
    pollInterval: 30,
    graylogEndpoint: 'https://gelf.pt.artemm.info/gelf'
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

async function processUrl(url, controlUrl, captureScreenshot = true) {
    const processId = Date.now();
    processLogger.info(`Starting URL processing ${processId}`, { url, captureScreenshot });
    
    // Set processing state in StateLock
    await stateLock.setState('processing', {
        url: url,
        processId: processId,
        startTime: Date.now()
    });
    isProcessing = true; // Keep for backward compatibility
    await saveState();
    let tab = null;
    let formattedContent = null;
    
    // Create timeout promise (8 minutes to match Python's timeout)
    const PROCESSING_TIMEOUT = 480000; // 8 minutes max
    const timeoutPromise = new Promise((_, reject) => {
        setTimeout(() => reject(new Error(`Processing timeout after ${PROCESSING_TIMEOUT/1000} seconds`)), PROCESSING_TIMEOUT);
    });
    
    try {
        // Race between actual processing and timeout
        formattedContent = await Promise.race([
            (async () => {
                processLogger.debug(`Process ${processId}: Creating tab`);
                tab = await chrome.tabs.create({ url, active: true });
                
                // Set target URL before waiting for network idle
                networkTracker.setTargetUrl(tab.id, url);
                
                processLogger.debug(`Process ${processId}: Waiting for tab load and security checks`);
                await waitForTabLoad(tab.id, captureScreenshot);
                
                processLogger.debug(`Process ${processId}: Extracting content`);
                const extractedContent = await extractContent(tab.id);
                
                // Wait additional time for any dynamic content
                await new Promise(resolve => setTimeout(resolve, 2000));
                
                let screenshot = null;
                if (captureScreenshot) {
                    processLogger.debug(`Process ${processId}: Capturing full page screenshot`);
                    const screenshotCapture = new ScreenshotCapture();
                    screenshot = await screenshotCapture.captureFullPage(tab.id);
                } else {
                    processLogger.info(`Process ${processId}: Skipping screenshot capture (text-only mode)`);
                }
                
                // Format the content according to server's expected schema
                const contentData = {
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
                    originalUrl: contentData.url,
                    transformedUrl: contentData.transformedUrl,
                    titleLength: contentData.content.title?.length,
                    contentLength: contentData.content.readableContent?.length,
                    screenshotSize: contentData.content.screenshot?.length,
                    contentPreview: contentData.content.readableContent?.substring(0, 100)
                });

                // Send to server with detailed logging
                try {
                    processLogger.debug(`Process ${processId}: Sending to server`, {
                        endpoint: controlUrl,
                        contentSize: JSON.stringify(contentData).length
                    });

                    const response = await fetch(controlUrl + '/submit', {
                        method: 'POST',
                        headers: {
                            'Content-Type': 'application/json',
                        },
                        body: JSON.stringify(contentData)
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
                return contentData;
            })(),
            timeoutPromise
        ]);
    } catch (error) {
        processLogger.error(`Process ${processId} failed`, {
            error: error.message,
            stack: error.stack,
            tabId: tab?.id,
            url: url,
            isTimeout: error.message.includes('timeout')
        });
        
        // Report error back to API
        try {
            await fetch(controlUrl + '/report_error', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    url: url,
                    error: error.message,
                    timestamp: new Date().toISOString()
                })
            });
            processLogger.info(`Process ${processId}: Error reported to server`);
        } catch (reportError) {
            processLogger.error(`Process ${processId}: Failed to report error`, {
                error: reportError.message,
                originalError: error.message
            });
        }
        
        throw error;
    } finally {
        // Always cleanup
        if (tab?.id) {
            try {
                await chrome.tabs.remove(tab.id);
                processLogger.debug(`Process ${processId}: Closed tab ${tab.id} after processing`);
            } catch (closeError) {
                processLogger.warn(`Process ${processId}: Failed to close tab ${tab.id}`, {
                    error: closeError.message
                });
            }
        }
        
        // Always reset state
        await stateLock.setState('idle');
        processLogger.debug(`Process ${processId}: Reset state to idle`);
        isProcessing = false; // Keep for backward compatibility
        await saveState();
    }
    
    return formattedContent;
}

const networkTracker = new NetworkRequestTracker();
const screenshotCapture = new ScreenshotCapture();

async function waitForTabLoad(tabId, captureScreenshot = true) {
    const pageLoadTimeout = 30000; // 30 seconds max for initial page load
    const waitLogger = new Logger('TabWait');
    
    return new Promise((resolve, reject) => {
        let listenerRemoved = false;
        
        // Define the listener function so we can remove it later
        const listener = function(id, info) {
            if (id === tabId && info.status === 'complete') {
                if (!listenerRemoved) {
                    listenerRemoved = true;
                    chrome.tabs.onUpdated.removeListener(listener);
                    waitLogger.info('Page reached complete status normally', { tabId });
                    proceedWithNetworkWait('complete');
                }
            }
        };
        
        // Add the listener
        chrome.tabs.onUpdated.addListener(listener);
        
        // Set up timeout for page load
        const timeoutId = setTimeout(() => {
            if (!listenerRemoved) {
                listenerRemoved = true;
                chrome.tabs.onUpdated.removeListener(listener);
                waitLogger.warn('Page load timeout - proceeding with partial content', { 
                    tabId, 
                    timeout: pageLoadTimeout 
                });
                proceedWithNetworkWait('timeout');
            }
        }, pageLoadTimeout);
        
        // Function to proceed with network wait
        function proceedWithNetworkWait(loadResult) {
            clearTimeout(timeoutId);
            
            // Use 30s timeout for all modes
            const networkTimeout = 30000;
            waitLogger.info(`Waiting for network idle after ${loadResult}`, {
                tabId,
                captureScreenshot,
                networkTimeout
            });
            
            networkTracker.waitForNetworkIdle(tabId, {
                timeout: networkTimeout,  // 30s for all modes
                quietPeriod: 2000,       // 2 seconds quiet period
                checkInterval: 100,
                ignoreScreenshotCapture: true,
                maxActiveRequests: 2     // Allow up to 2 active requests
            })
            .then(() => {
                waitLogger.info('Network idle achieved', { tabId, loadResult });
                resolve();
            })
            .catch((error) => {
                waitLogger.error('Network wait failed', { tabId, error: error.message });
                reject(error);
            });
        }
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
    
    // Try to acquire polling lock
    const lockId = await stateLock.tryAcquireLock('polling', 3, 1000);
    if (!lockId) {
        pollLogger.warn('Could not acquire polling lock, skipping', { 
            pollId,
            message: 'Another poll is already in progress'
        });
        return false; // Indicate polling is already active
    }
    
    pollLogger.debug(`Starting poll ${pollId}`, { url: controlUrl, lockId });
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
            return true; // Continue polling
        }

        if (!response.ok) {
            throw new Error(`HTTP error! status: ${response.status}`);
        }

        const data = await response.json();
        pollLogger.info(`Poll ${pollId}: Received URL`, { url: data.url });

        if (data.url) {
            setStatus(`Processing URL: ${data.url}`);
            try {
                await processUrl(data.url, controlUrl, data.capture_screenshot);
            } catch (processError) {
                // Log with full context
                pollLogger.error(`Processing failed for ${data.url}`, {
                    error: processError.message,
                    stack: processError.stack,
                    url: data.url,
                    isTimeout: processError.message.includes('timeout'),
                    timestamp: new Date().toISOString()
                });
                
                // Try to report to server (don't let this break polling)
                try {
                    const response = await fetch(controlUrl + '/report_error', {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({
                            url: data.url,
                            error: processError.message,
                            timestamp: new Date().toISOString()
                        })
                    });
                    if (response.ok) {
                        pollLogger.info('Error reported to server successfully');
                    } else {
                        pollLogger.warn(`Server error report failed with status ${response.status}`);
                    }
                } catch (reportError) {
                    pollLogger.warn('Failed to report error to server', {
                        error: reportError.message,
                        originalError: processError.message
                    });
                }
            }
            return true; // Always continue polling
        }
        
        return true; // Continue polling
    } catch (error) {
        if (error.name === 'AbortError') {
            pollLogger.debug(`Poll ${pollId}: Request timeout - normal during idle periods`);
            return true; // Continue polling after timeout
        } else {
            pollLogger.error(`Poll ${pollId} failed`, {
                error: error.message,
                stack: error.stack
            });
            // For other errors, stop continuous polling (alarm will restart it)
            return false;
        }
    } finally {
        // Always release the lock
        await stateLock.releaseLock('polling', lockId);
        pollLogger.debug(`Poll ${pollId}: Released lock`, { lockId });
    }
}

async function startContinuousPolling(controlUrl) {
    if (isContinuousPolling) {
        pollLogger.debug('Continuous polling already active');
        return;
    }
    
    isContinuousPolling = true;
    pollLogger.info('Starting continuous polling', { controlUrl });
    
    while (isContinuousPolling) {
        const shouldContinue = await pollServer(controlUrl);
        
        if (!shouldContinue) {
            pollLogger.warn('Continuous polling stopped due to error');
            isContinuousPolling = false;
            break;
        }
        
        // Small delay between polls to prevent CPU spinning
        if (isContinuousPolling) {
            await new Promise(resolve => setTimeout(resolve, 100));
        }
    }
    
    pollLogger.info('Continuous polling ended');
}

async function stopContinuousPolling() {
    pollLogger.info('Stopping continuous polling');
    isContinuousPolling = false;
}

async function initializeExtension() {
    initLogger.info('Extension initialization started');
    
    try {
        // Restore previous state
        await restoreState();
        
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
    
    // Clear any existing alarms
    await chrome.alarms.clear(ALARM_NAME);
    
    setStatus('Starting polling');
    lastPollTime = Date.now();
    
    // Save state for persistence
    await saveState();
    
    // Create repeating alarm as backup (minimum 0.5 minutes = 30 seconds)
    const periodInMinutes = Math.max(0.5, settings.pollInterval / 60);
    chrome.alarms.create(ALARM_NAME, {
        periodInMinutes: periodInMinutes
    });
    
    pollLogger.info(`Set up backup alarm every ${periodInMinutes} minutes (${settings.pollInterval} seconds)`);
    
    // Start continuous polling
    startContinuousPolling(settings.controlUrl);
}

// State persistence functions
async function saveState() {
    await chrome.storage.local.set({
        lastPollTime: lastPollTime,
        isProcessing: isProcessing,
        currentStatus: currentStatus
    });
}

async function restoreState() {
    const state = await chrome.storage.local.get(['lastPollTime', 'isProcessing', 'currentStatus']);
    if (state.lastPollTime) {
        const timeSinceLastPoll = Date.now() - state.lastPollTime;
        if (timeSinceLastPoll > 120000) { // 2 minutes
            initLogger.warn(`Detected suspension - ${timeSinceLastPoll}ms since last poll`);
        }
        lastPollTime = state.lastPollTime;
    }
    if (state.isProcessing !== undefined) isProcessing = state.isProcessing;
    if (state.currentStatus) currentStatus = state.currentStatus;
    return state;
}

// Alarm listener for persistent polling (backup mechanism)
chrome.alarms.onAlarm.addListener(async (alarm) => {
    if (alarm.name === ALARM_NAME) {
        const settings = await chrome.storage.sync.get(['controlUrl']);
        
        if (settings.controlUrl && !isContinuousPolling) {
            pollLogger.info('Alarm triggered - restarting continuous polling');
            lastPollTime = Date.now();
            await saveState();
            
            // Check for stale processing state
            const processingState = await stateLock.getState('processing');
            if (processingState) {
                const age = Date.now() - processingState.startTime;
                if (age > 600000) { // 10 minutes - definitely stale
                    pollLogger.warn('Clearing stale processing state', {
                        url: processingState.url,
                        age: age,
                        processId: processingState.processId
                    });
                    await stateLock.clearState('processing');
                    isProcessing = false;
                    await saveState();
                }
            }
            
            // Restart continuous polling
            startContinuousPolling(settings.controlUrl);
        } else {
            pollLogger.debug('Skipping alarm - continuous polling active', { 
                hasControlUrl: !!settings.controlUrl,
                isContinuousPolling: isContinuousPolling
            });
        }
    }
});

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
            stopContinuousPolling();
            chrome.alarms.clear(ALARM_NAME).then(() => {
                setStatus('Polling stopped');
                return saveState();
            }).then(() => {
                sendResponse({ status: currentStatus });
            }).catch(error => {
                messageLogger.error('Error stopping polling', error);
                sendResponse({ status: 'Error: ' + error.message });
            });
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
            
        case 'content_log':
            // Log messages from content scripts
            const contentLogger = new Logger('CONTENT');
            const level = request.level || 'info';
            if (contentLogger[level]) {
                contentLogger[level](request.message, {
                    tabId: sender.tab?.id,
                    url: sender.tab?.url,
                    ...request.data
                });
            }
            break;
    }
    
    return true;
});

// Initialize alarms on install/update
chrome.runtime.onInstalled.addListener(async ({ reason }) => {
    logger.info('Extension installed/updated', { reason, time: new Date().toISOString() });
    
    // Get current settings and start polling if configured
    const settings = await chrome.storage.sync.get(['controlUrl', 'pollInterval']);
    if (settings.controlUrl && settings.pollInterval) {
        const interval = parseInt(settings.pollInterval);
        const periodInMinutes = Math.max(0.5, interval / 60); // Convert seconds to minutes, minimum 30s
        await chrome.alarms.create(ALARM_NAME, { periodInMinutes: periodInMinutes });
        logger.info('Polling alarm created', { intervalSeconds: interval, periodInMinutes: periodInMinutes });
        
        // Start continuous polling immediately
        startContinuousPolling(settings.controlUrl);
    }
});

// Initialize alarms on browser startup
chrome.runtime.onStartup.addListener(async () => {
    logger.info('Browser started, extension loading', { time: new Date().toISOString() });
    
    // Restore alarms
    const settings = await chrome.storage.sync.get(['controlUrl', 'pollInterval']);
    if (settings.controlUrl && settings.pollInterval) {
        const interval = parseInt(settings.pollInterval);
        const periodInMinutes = Math.max(0.5, interval / 60); // Convert seconds to minutes, minimum 30s
        await chrome.alarms.create(ALARM_NAME, { periodInMinutes: periodInMinutes });
        logger.info('Polling alarm restored', { intervalSeconds: interval, periodInMinutes: periodInMinutes });
        
        // Start continuous polling immediately
        startContinuousPolling(settings.controlUrl);
    }
});

// Initialize the extension
logger.info('Background script loaded');
initializeExtension().catch(error => {
    logger.error('Fatal initialization error', error);
});