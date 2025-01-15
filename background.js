// background.js
import UrlSettingsManager from './urlSettingsManager.js';

let pollingInterval = null;
let currentStatus = 'Idle';
let currentTab = null;
let isProcessing = false;
let currentError = null;

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
    if (isProcessing) {
        log('PROCESS', 'Already processing a URL, skipping');
        return;
    }
    
    isProcessing = true;
    log('PROCESS', `Starting to process URL: ${url}`);
    
    try {
        // Close previous tab if exists
        if (currentTab) {
            log('TAB', `Closing previous tab: ${currentTab.id}`);
            try {
                await chrome.tabs.remove(currentTab.id);
            } catch (e) {
                log('TAB_ERROR', 'Error closing previous tab', e);
            }
            currentTab = null;
        }
        
        // Create new tab
        log('TAB', 'Creating new tab');
        currentTab = await chrome.tabs.create({ url: url, active: true });
        log('TAB', `Created tab with ID: ${currentTab.id}`);
        
        // Wait for the page to load
        log('PAGE', 'Waiting for page to load');
        await new Promise((resolve, reject) => {
            const timeout = setTimeout(() => {
                reject(new Error('Page load timeout after 30s'));
            }, 30000);

            chrome.tabs.onUpdated.addListener(function listener(tabId, info) {
                if (tabId === currentTab.id && info.status === 'complete') {
                    log('PAGE', `Page loaded in tab ${tabId}`);
                    chrome.tabs.onUpdated.removeListener(listener);
                    clearTimeout(timeout);
                    resolve();
                }
            });
        });

        // Wait a bit for dynamic content
        log('PAGE', 'Waiting for dynamic content');
        await new Promise(resolve => setTimeout(resolve, 2000));

        // Extract content
        log('EXTRACT', 'Starting content extraction');
        const [result] = await chrome.scripting.executeScript({
            target: { tabId: currentTab.id },
            function: () => ({
                url: window.location.href,
                title: document.title,
                content: document.body.innerText,
                html: document.documentElement.outerHTML
            })
        });
        log('EXTRACT', 'Content extracted successfully', { title: result.result.title });

        // Get control URL from storage
        const settings = await urlSettingsManager.getStorageSync(defaultSettings);
        if (!settings.controlUrl) {
            throw new Error('Control URL not found in settings');
        }

        // Send results to server
        log('SUBMIT', `Submitting results to ${settings.controlUrl}/submit`);
        const submitResponse = await fetch(`${settings.controlUrl}/submit`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                url: url,
                content: result.result
            })
        });

        if (!submitResponse.ok) {
            throw new Error(`Server responded with ${submitResponse.status}`);
        }

        log('SUBMIT', 'Results submitted successfully');
        setStatus(`Successfully processed: ${url}`);

    } catch (error) {
        log('ERROR', `Failed to process ${url}`, error);
        setStatus('Error processing URL', error.message);
    } finally {
        // Cleanup
        if (currentTab) {
            try {
                await chrome.tabs.remove(currentTab.id);
                log('CLEANUP', `Removed tab ${currentTab.id}`);
            } catch (e) {
                log('CLEANUP_ERROR', 'Error removing tab', e);
            }
            currentTab = null;
        }
        isProcessing = false;
    }
}

async function pollServer(controlUrl) {
    try {
        log('POLL', 'Starting poll');
        const response = await fetchWithTimeout(`${controlUrl}/get_url`);
        
        if (response.status === 204) {
            log('POLL', 'No URLs in queue');
            return;
        }

        if (!response.ok) {
            throw new Error(`HTTP error! status: ${response.status}`);
        }

        const data = await response.json();
        log('POLL', 'Received URL from server');

        if (data.url) {
            setStatus('Processing URL: ' + data.url);
            await processUrl(data.url);
        }
    } catch (error) {
        log('POLL_ERROR', 'Polling failed', error);
        setStatus('Polling error', error.message);
    }
}

// Initialize settings from URL if present
chrome.runtime.onInstalled.addListener(async () => {
    log('INSTALL', 'Extension installed/updated');
    await urlSettingsManager.checkConfigTabs();
});

chrome.runtime.onStartup.addListener(async () => {
    log('STARTUP', 'Extension starting up');
    await urlSettingsManager.checkConfigTabs();
});

// Initialize tab listeners for URL-based configuration
urlSettingsManager.initializeTabListeners(defaultSettings);

// Handle messages from popup
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
    log('MESSAGE', `Received message: ${request.type}`);
    
    switch (request.type) {
        case "start_polling":
            if (pollingInterval) {
                clearInterval(pollingInterval);
                log('POLLING', 'Cleared existing interval');
            }
            
            setStatus('Starting polling');
            
            // Update settings from request
            urlSettingsManager.setStorageSync({
                controlUrl: request.controlUrl,
                pollInterval: request.pollInterval
            }).then(() => {
                // Initial poll
                pollServer(request.controlUrl).catch(error => {
                    log('POLLING_ERROR', 'Initial poll failed', error);
                });

                // Set up recurring polls
                pollingInterval = setInterval(() => {
                    if (!isProcessing) {
                        pollServer(request.controlUrl).catch(error => {
                            log('POLLING_ERROR', 'Interval poll failed', error);
                        });
                    } else {
                        log('POLLING', 'Skipping poll - processing in progress');
                    }
                }, request.pollInterval * 1000);
            });
            
            sendResponse({ 
                status: currentStatus,
                error: currentError,
                currentTab: currentTab?.url
            });
            break;

        case "stop_polling":
            if (pollingInterval) {
                clearInterval(pollingInterval);
                pollingInterval = null;
                setStatus('Polling stopped');
                log('POLLING', 'Polling stopped');
            }
            sendResponse({ 
                status: currentStatus,
                error: currentError,
                currentTab: currentTab?.url
            });
            break;

        case "get_status":
            sendResponse({ 
                status: currentStatus,
                error: currentError,
                currentTab: currentTab?.url
            });
            break;
    }
    return true;
});