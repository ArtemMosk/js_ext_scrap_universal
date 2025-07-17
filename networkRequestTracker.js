import Logger from './logger.js';

export default class NetworkRequestTracker {
    constructor() {
        this.activeRequests = new Map();  // tabId -> Map of requestId -> request
        this.targetUrls = new Map();      // tabId -> target URL
        this.logger = new Logger('NetworkTracker');
        this.setupListeners();
    }

    setTargetUrl(tabId, url) {
        this.targetUrls.set(tabId, new URL(url).origin);
        this.logger.debug(`Set target URL for tab ${tabId}`, { targetUrl: url });
    }

    isRelevantRequest(details, targetOrigin) {
        if (!targetOrigin) return false;
        
        try {
            const requestOrigin = new URL(details.url).origin;
            return requestOrigin === targetOrigin;
        } catch (e) {
            return false;
        }
    }

    setupListeners() {
        chrome.webRequest.onBeforeRequest.addListener(
            (details) => this.handleRequest('start', details),
            { urls: ['<all_urls>'] }
        );

        chrome.webRequest.onCompleted.addListener(
            (details) => this.handleRequest('complete', details),
            { urls: ['<all_urls>'] }
        );

        chrome.webRequest.onErrorOccurred.addListener(
            (details) => this.handleRequest('error', details),
            { urls: ['<all_urls>'] }
        );
    }

    handleRequest(type, details) {
        const { tabId, requestId } = details;
        if (tabId < 0) return;

        const targetOrigin = this.targetUrls.get(tabId);
        if (!this.isRelevantRequest(details, targetOrigin)) {
            return;
        }

        if (!this.activeRequests.has(tabId)) {
            this.activeRequests.set(tabId, new Map());
        }
        const requests = this.activeRequests.get(tabId);

        if (type === 'start') {
            requests.set(requestId, details);
            this.logger.debug(`New request tracked`, { 
                tabId, 
                requestId,
                url: details.url,
                activeCount: requests.size 
            });
        } else {
            requests.delete(requestId);
            this.logger.debug(`Request ${type}`, { 
                tabId, 
                requestId,
                url: details.url,
                activeCount: requests.size 
            });
        }
    }

    async waitForNetworkIdle(tabId, options = {}) {
        const {
            timeout = 45000,
            quietPeriod = 500,
            checkInterval = 100,
            maxActiveRequests = 2
        } = options;
        

        if (!this.targetUrls.has(tabId)) {
            throw new Error('No target URL set for tab');
        }

        this.logger.debug(`Starting network idle wait for tab ${tabId}`, { 
            timeout,
            quietPeriod,
            maxActiveRequests 
        });
        
        return new Promise((resolve, reject) => {
            const startTime = Date.now();
            let quietStartTime = null;
            let lastRequestCount = 0;
            
            const checkQuietPeriod = () => {
                const requests = this.activeRequests.get(tabId);
                const currentCount = requests ? requests.size : 0;
                const elapsedTime = Date.now() - startTime;
                
                if (currentCount !== lastRequestCount) {
                    this.logger.debug(`Active requests changed`, { 
                        tabId, 
                        activeRequests: currentCount,
                        urls: Array.from(requests?.values() || []).map(r => r.url),
                        elapsedTime: elapsedTime
                    });
                    lastRequestCount = currentCount;
                }
                
                // Log every 5 seconds for long-running waits
                if (elapsedTime % 5000 < checkInterval) {
                    this.logger.info(`Still waiting for network idle`, {
                        tabId,
                        activeRequests: currentCount,
                        elapsedTime: elapsedTime,
                        targetUrl: targetUrl
                    });
                }

                if (currentCount <= maxActiveRequests) {
                    if (!quietStartTime) {
                        quietStartTime = Date.now();
                        this.logger.debug(`Starting quiet period`, { 
                            tabId, 
                            activeRequests: currentCount,
                            elapsedTime: Date.now() - startTime
                        });
                    } else if (Date.now() - quietStartTime >= quietPeriod) {
                        this.logger.debug(`Network idle achieved`, { 
                            tabId, 
                            activeRequests: currentCount,
                            totalTime: Date.now() - startTime
                        });
                        clearInterval(intervalId);
                        this.cleanup(tabId);
                        resolve();
                    }
                } else {
                    quietStartTime = null;
                }

                if (Date.now() - startTime >= timeout) {
                    clearInterval(intervalId);
                    this.cleanup(tabId);
                    
                    // Log detailed timeout info
                    const activeUrls = Array.from(requests?.values() || []).map(r => r.url);
                    this.logger.error(`Network idle timeout`, { 
                        tabId,
                        activeRequests: currentCount,
                        urls: activeUrls,
                        targetUrl: targetUrl,
                        totalWaitTime: Date.now() - startTime
                    });
                    
                    reject(new Error('Network idle timeout'));
                }
            };

            const intervalId = setInterval(checkQuietPeriod, checkInterval);
        });
    }

    cleanup(tabId) {
        this.activeRequests.delete(tabId);
        this.targetUrls.delete(tabId);
        this.logger.debug(`Cleaned up tab tracking`, { tabId });
    }
} 