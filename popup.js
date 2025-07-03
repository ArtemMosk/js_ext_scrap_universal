// popup.js
document.addEventListener('DOMContentLoaded', async () => {
    // Load saved settings from sync storage
    const settings = await chrome.storage.sync.get(['controlUrl', 'pollInterval']);
    if (settings.controlUrl) {
        document.getElementById('control-url').value = settings.controlUrl;
    }
    if (settings.pollInterval) {
        document.getElementById('poll-interval').value = settings.pollInterval;
    }

    // Update status
    chrome.runtime.sendMessage({ type: "get_status" }, response => {
        document.getElementById('status').textContent = `Status: ${response.status}`;
    });

    // Debug functionality
    document.getElementById('debug-current-page').addEventListener('click', async () => {
        const debugResults = document.getElementById('debug-results');
        debugResults.textContent = 'Processing current page...';

        try {
            // Get current active tab
            const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
            
            // Check if we can inject content script
            if (!tab.url.startsWith('http')) {
                debugResults.textContent = 'Error: Cannot process this type of page. Please try on a regular webpage.';
                return;
            }

            // Try to inject content script if not already present
            try {
                await chrome.scripting.executeScript({
                    target: { tabId: tab.id },
                    files: ['contentExtractor.js']
                });
            } catch (e) {
                // Script might already be injected, which is fine
                console.log('Content script might already be present:', e);
            }
            
            // Extract content
            const content = await new Promise((resolve, reject) => {
                chrome.tabs.sendMessage(tab.id, { type: "extract_content" }, response => {
                    if (chrome.runtime.lastError) {
                        if (chrome.runtime.lastError.message.includes('Receiving end does not exist')) {
                            reject(new Error('Content script not loaded. Please refresh the page and try again.'));
                        } else {
                            reject(chrome.runtime.lastError);
                        }
                        return;
                    }
                    resolve(response.content);
                });
            });

            // Format and display results
            const results = {
                url: content.url,
                title: content.title,
                rawContentLength: content.rawPurifiedContent.length,
                readableContentLength: content.readableContent.length,
                rawContentPreview: content.rawPurifiedContent.substring(0, 200) + '...',
                readableContentPreview: content.readableContent.substring(0, 200) + '...'
            };

            debugResults.textContent = JSON.stringify(results, null, 2);
        } catch (error) {
            debugResults.textContent = `Error: ${error.message}`;
        }
    });

    // Save settings
    document.getElementById('save-settings').addEventListener('click', async () => {
        try {
            const controlUrl = document.getElementById('control-url').value;
            const pollInterval = parseInt(document.getElementById('poll-interval').value);

            // Validate inputs
            if (!controlUrl) {
                document.getElementById('status').textContent = 'Error: Please enter a control server URL';
                return;
            }

            try {
                new URL(controlUrl); // Validate URL format
            } catch (e) {
                document.getElementById('status').textContent = 'Error: Invalid URL format';
                return;
            }

            if (isNaN(pollInterval) || pollInterval < 1) {
                document.getElementById('status').textContent = 'Error: Poll interval must be at least 1 second';
                return;
            }

            await chrome.storage.sync.set({
                controlUrl,
                pollInterval
            });

            document.getElementById('status').textContent = 'Settings saved successfully';
        } catch (error) {
            document.getElementById('status').textContent = `Error saving settings: ${error.message}`;
        }
    });

    // Start polling
    document.getElementById('start-polling').addEventListener('click', async () => {
        const controlUrl = document.getElementById('control-url').value;
        const pollInterval = parseInt(document.getElementById('poll-interval').value);

        if (!controlUrl) {
            document.getElementById('status').textContent = 'Error: Please enter a control server URL';
            return;
        }

        if (pollInterval < 1) {
            document.getElementById('status').textContent = 'Error: Poll interval must be at least 1 second';
            return;
        }

        // Save settings before starting
        await chrome.storage.sync.set({
            controlUrl,
            pollInterval
        });

        chrome.runtime.sendMessage({ 
            type: "start_polling",
            controlUrl,
            pollInterval
        }, response => {
            if (chrome.runtime.lastError) {
                document.getElementById('status').textContent = `Error: ${chrome.runtime.lastError.message}`;
                return;
            }
            if (response && response.status) {
                document.getElementById('status').textContent = `Status: ${response.status}`;
            }
        });
    });

    // Stop polling
    document.getElementById('stop-polling').addEventListener('click', () => {
        chrome.runtime.sendMessage({ type: "stop_polling" }, response => {
            if (chrome.runtime.lastError) {
                document.getElementById('status').textContent = `Error: ${chrome.runtime.lastError.message}`;
                return;
            }
            if (response && response.status) {
                document.getElementById('status').textContent = `Status: ${response.status}`;
            }
        });
    });

    // Clear settings
    document.getElementById('clear-settings').addEventListener('click', async () => {
        if (!confirm('Are you sure you want to clear all settings?')) {
            return;
        }

        try {
            await chrome.storage.sync.clear();
            document.getElementById('control-url').value = '';
            document.getElementById('poll-interval').value = '30';
            document.getElementById('status').textContent = 'Status: Settings cleared';
        } catch (error) {
            document.getElementById('status').textContent = `Error clearing settings: ${error.message}`;
        }
    });

    // View logs
    document.getElementById('view-logs').addEventListener('click', async () => {
        const status = document.getElementById('status');
        status.textContent = 'Loading logs...';

        try {
            // Get logs from storage
            const logs = await chrome.runtime.sendMessage({ type: "get_logs" });
            
            if (!logs || Object.keys(logs).length === 0) {
                status.textContent = 'No logs available';
                return;
            }

            // Open logs in a new tab
            const blob = new Blob([JSON.stringify(logs, null, 2)], { type: 'application/json' });
            const url = URL.createObjectURL(blob);
            chrome.tabs.create({ url });
            status.textContent = 'Logs opened in new tab';
        } catch (error) {
            status.textContent = `Error viewing logs: ${error.message}`;
        }
    });
});