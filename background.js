// background.js
import UrlSettingsManager from './urlSettingsManager.js';
import Logger from './logger.js';
import NetworkRequestTracker from './networkRequestTracker.js';
import ScreenshotCapture from './backgroundScreenshotHandler.js';
import { StateLock } from './stateLock.js';
import { runInteractionTask, authHeaders } from './interactionRunner.js';
import { PollController } from './pollController.js';
import { makePollOnce } from './pollAdapter.js';
import { PollLifecycleCoordinator } from './pollLifecycleCoordinator.js';
import { LifecycleJournal } from './lifecycleJournal.js';
import { resetExtensionSettings } from './settingsReset.js';

// Loggers for different components
const logger = new Logger();
const pollLogger = new Logger('POLL');
const initLogger = new Logger('INIT');
const settingsLogger = new Logger('SETTINGS');
const processLogger = new Logger('PROCESS');
const statusLogger = new Logger('STATUS');
const messageLogger = new Logger('MESSAGE');
const tabLogger = new Logger('TAB');
const lockLogger = new Logger('LOCK');

// Initialize StateLock
const stateLock = new StateLock(lockLogger);

const ALARM_NAME = 'pollServer';
let isProcessing = false;
let currentStatus = 'Idle';

// Initialize URL Settings Manager
const urlSettingsManager = new UrlSettingsManager(console);

// Define default settings matching your existing ones
const defaultSettings = {
    controlUrl: '',
    pollInterval: 30,
    graylogEndpoint: 'https://gelf.pt.artemm.info/gelf'
};
// Register synchronously at module evaluation so MV3 cannot suspend before the listener exists.
// initializeExtension() separately scans already-open tabs to cover a config page that loaded first.
urlSettingsManager.initializeTabListeners(defaultSettings);

// Auto-start: when no controlUrl is stored, poll this server on load. Lets the
// extension work in a browser we can't configure post-launch (default-profile
// Chrome blocks remote debugging). Empty string = disabled (normal behaviour).
const AUTOSTART_CONTROL_URL = '';  // no infra hardcode: configure via popup (C4)
// Advertised on every poll; the server's capability gate only hands us jobs we can run.
const EXT_CAPABILITIES = 'uploadFile,extractImage,detectTextPatterns,clickTextMatch,awaitResult,debugWatch,windowState,pageReload';

// Direct status setter without logging
function setStatus(status) {
    statusLogger.info('Status changing', { from: currentStatus, to: status });
    currentStatus = status;
}

async function acknowledgeExtensionControl(controlUrl, command, status, message = null) {
    try {
        await fetch(`${controlUrl}/extension/control_ack`, {
            method: 'POST',
            headers: await authHeaders({ 'Content-Type': 'application/json' }),
            body: JSON.stringify({
                command_id: command.id || null,
                action: command.action,
                status,
                version: chrome.runtime.getManifest().version,
                message
            })
        });
    } catch (error) {
        pollLogger.warn('Failed to acknowledge extension control command', {
            action: command.action,
            commandId: command.id,
            error: error.message
        });
    }
}

async function handleExtensionControlCommand(payload, controlUrl) {
    const command = payload.command || payload;
    if (!command || command.action !== 'reload') {
        throw new Error(`Unknown extension control command: ${String(command && command.action)}`);
    }

    pollLogger.warn('Extension reload requested by control server', {
        commandId: command.id,
        reason: command.reason,
        createdAt: command.created_at
    });

    setStatus('Reloading extension');
    pollCoordinator.prepareReload('server-command');
    await saveState();
    await acknowledgeExtensionControl(controlUrl, command, 'reloading');

    setTimeout(() => {
        chrome.runtime.reload();
    }, 100);

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
                        headers: await authHeaders({ 'Content-Type': 'application/json' }),
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
                headers: await authHeaders({ 'Content-Type': 'application/json' }),
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

async function processInteractionTask(task, controlUrl) {
    const processId = Date.now();
    processLogger.info(`Starting interaction task ${processId}`, {
        taskId: task.task_id, taskString: task.task_string
    });

    await stateLock.setState('processing', {
        url: `interaction:${task.task_id}`,
        processId: processId,
        startTime: Date.now()
    });
    isProcessing = true;
    await saveState();

    try {
        // Timeout/cleanup/result-reporting (incl. failure submission to /submit_task)
        // are handled inside runInteractionTask via its deadline.
        // Reuse-tab id + its context live in storage.session so they survive SW restarts. The
        // context (reuse scope + reference set, set by the server) lets the runner skip
        // navigate+upload ONLY when the stored tab genuinely matches this task (B3).
        const getReuseTab = async () => {
            try {
                const r = await chrome.storage.session.get(['reuseTabId', 'reuseContext']);
                return (r && r.reuseTabId != null) ? { id: r.reuseTabId, context: r.reuseContext || '' } : null;
            } catch (_) { return null; }
        };
        const setReuseTab = async (tid, context) => {
            try { await chrome.storage.session.set({ reuseTabId: tid, reuseContext: context || '' }); }
            catch (_) { /* ignore */ }
        };
        await runInteractionTask(task, controlUrl, { waitForTabLoad, networkTracker, getReuseTab, setReuseTab });
        processLogger.info(`Interaction task ${processId} completed`, { taskId: task.task_id });
    } finally {
        await stateLock.setState('idle');
        isProcessing = false;
        await saveState();
    }
}

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

async function dispatchPollPayload(data, controlUrl) {
    pollLogger.info('Received poll payload', {
        type: data.type || 'url',
        action: data.command?.action || data.action,
    });

    if (data.type === 'extension_control') {
        await handleExtensionControlCommand(data, controlUrl);
        return;
    }

    if (data.type === 'interaction_task' && data.task) {
        setStatus(`Processing interaction task: ${data.task.task_id}`);
        try {
            await processInteractionTask(data.task, controlUrl);
        } catch (taskError) {
            // The runner already submitted the failed result. Keep polling, but retain the evidence.
            pollLogger.error(`Interaction task failed: ${data.task.task_id}`, {
                error: taskError.message,
                stack: taskError.stack,
                timestamp: new Date().toISOString(),
            });
        }
        return;
    }

    if (data.url) {
        setStatus(`Processing URL: ${data.url}`);
        try {
            await processUrl(data.url, controlUrl, data.capture_screenshot);
        } catch (processError) {
            pollLogger.error(`Processing failed for ${data.url}`, {
                error: processError.message,
                stack: processError.stack,
                url: data.url,
                isTimeout: processError.message.includes('timeout'),
                timestamp: new Date().toISOString(),
            });
            try {
                const response = await fetch(controlUrl + '/report_error', {
                    method: 'POST',
                    headers: await authHeaders({ 'Content-Type': 'application/json' }),
                    body: JSON.stringify({
                        url: data.url,
                        error: processError.message,
                        timestamp: new Date().toISOString(),
                    }),
                });
                if (!response.ok) {
                    pollLogger.warn(`Server error report failed with status ${response.status}`);
                }
            } catch (reportError) {
                pollLogger.warn('Failed to report error to server', {
                    error: reportError.message,
                    originalError: processError.message,
                });
            }
        }
        return;
    }

    throw new Error(`Unsupported poll payload type: ${String(data.type)}`);
}

const lifecycleJournal = new LifecycleJournal({
    storage: chrome.storage.local,
    logger: pollLogger,
});
const pollQuery = `?v=${encodeURIComponent(chrome.runtime.getManifest().version)}` +
    `&caps=${encodeURIComponent(EXT_CAPABILITIES)}&client=extension`;
const pollOnce = makePollOnce({
    authHeaders,
    query: pollQuery,
    dispatch: dispatchPollPayload,
});
const pollController = new PollController({
    pollOnce,
    logger: pollLogger,
    onExit: (event) => lifecycleJournal.append('poll_exit', event),
});
const pollCoordinator = new PollLifecycleCoordinator({
    controller: pollController,
    storage: chrome.storage.sync,
    alarms: chrome.alarms,
    alarmName: ALARM_NAME,
    logger: pollLogger,
    onEvent: (event) => lifecycleJournal.append(event),
    onStatus: setStatus,
});

async function initializeExtension() {
    initLogger.info('Extension initialization started');

    try {
        // Defensive credential hygiene (best-effort, NOT on the auth path): clear any bearer token a
        // pre-1.3.13 build may have written to chrome.storage.sync (which replicates to Google). The
        // live token lives only in storage.local; a failure here can never affect auth or block init.
        chrome.storage.sync.remove('apiToken').catch(() => {});

        // Restore previous state
        await restoreState();

        initLogger.debug('Initializing UrlSettingsManager');
        urlSettingsManager.onSettingsUpdated = async (newSettings) => {
            settingsLogger.info('Settings updated from URL', newSettings);
            await pollCoordinator.start(newSettings, 'config-url');
        };
        
        const settings = await chrome.storage.sync.get(['controlUrl']);
        // Existing config tabs are bootstrap input only. Replaying every historical tab on each
        // worker wake makes tab enumeration order override the durable current configuration.
        if (!settings.controlUrl) {
            initLogger.debug('Unconfigured profile - checking existing config tabs');
            await urlSettingsManager.checkConfigTabs();
        }
        if (!settings.controlUrl && AUTOSTART_CONTROL_URL) {
            const auto = { controlUrl: AUTOSTART_CONTROL_URL, pollInterval: 30 };
            initLogger.info('No stored settings — AUTO-STARTING polling', auto);
            await pollCoordinator.start(auto, 'autostart');
        } else {
            await pollCoordinator.reconcile('initialize');
        }

        lifecycleJournal.append('boot');
        initLogger.info('Extension initialization completed');
    } catch (error) {
        initLogger.error('Extension initialization failed', error);
        lifecycleJournal.append('boot_failed', { reason: error?.name || 'Error' });
    }
}

// State persistence functions
async function saveState() {
    await chrome.storage.local.set({
        isProcessing: isProcessing,
        currentStatus: currentStatus
    });
}

async function restoreState() {
    const state = await chrome.storage.local.get(['isProcessing', 'currentStatus']);
    if (state.isProcessing !== undefined) isProcessing = state.isProcessing;
    if (state.currentStatus) currentStatus = state.currentStatus;
    return state;
}

chrome.alarms.onAlarm.addListener(async (alarm) => {
    if (alarm.name !== ALARM_NAME) { return; }
    try {
        const processingState = await stateLock.getState('processing');
        if (processingState && Date.now() - processingState.startTime > 600000) {
            pollLogger.warn('Clearing stale processing state', {
                age: Date.now() - processingState.startTime,
                processId: processingState.processId,
            });
            await stateLock.clearState('processing');
            isProcessing = false;
            await saveState();
        }
        await pollCoordinator.reconcile('alarm');
    } catch (error) {
        pollLogger.error('Alarm reconcile failed', { error: error.message, stack: error.stack });
        lifecycleJournal.append('alarm_failed', { reason: error?.name || 'Error' });
    }
});

// Message handling
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
    messageLogger.debug('Message received', { type: request.type, sender: sender.id });
    
    switch (request.type) {
        case 'start_polling':
            messageLogger.info('Start polling requested', request);
            pollCoordinator.start(request, 'popup-start').then(() => {
                sendResponse({ status: currentStatus });
            }).catch(error => {
                messageLogger.error('Error starting polling', error);
                sendResponse({ status: 'Error: ' + error.message });
            });
            break;
            
        case 'stop_polling':
            messageLogger.info('Stop polling requested');
            pollCoordinator.stop('popup-stop').then(() => saveState()).then(() => {
                sendResponse({ status: currentStatus });
            }).catch(error => {
                messageLogger.error('Error stopping polling', error);
                sendResponse({ status: 'Error: ' + error.message });
            });
            break;

        case 'clear_settings':
            messageLogger.warn('Clear all settings requested');
            resetExtensionSettings({
                coordinator: pollCoordinator,
                journal: lifecycleJournal,
                localStorage: chrome.storage.local,
                sessionStorage: chrome.storage.session,
            }).then(() => {
                isProcessing = false;
                currentStatus = 'Idle';
                sendResponse({ status: 'Settings cleared' });
            }).catch(error => {
                messageLogger.error('Error clearing settings', error);
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
chrome.runtime.onInstalled.addListener(({ reason }) => {
    logger.info('Extension installed/updated', { reason, time: new Date().toISOString() });
    pollCoordinator.reconcile(`installed:${reason}`).catch((error) => {
        initLogger.error('Install reconcile failed', error);
    });
});

// Initialize alarms on browser startup
chrome.runtime.onStartup.addListener(() => {
    logger.info('Browser started, extension loading', { time: new Date().toISOString() });
    pollCoordinator.reconcile('startup').catch((error) => {
        initLogger.error('Startup reconcile failed', error);
    });
});

chrome.storage.onChanged.addListener((changes, areaName) => {
    if (areaName !== 'sync') { return; }
    if (!['controlUrl', 'pollInterval', 'pollingEnabled'].some((key) => key in changes)) { return; }
    pollCoordinator.reconcile('settings-changed').catch((error) => {
        settingsLogger.error('Settings reconcile failed', error);
    });
});

// Initialize the extension
logger.info('Background script loaded');
initializeExtension().catch(error => {
    logger.error('Fatal initialization error', error);
});
