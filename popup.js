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
});

document.getElementById('start-polling').addEventListener('click', async () => {
    const controlUrl = document.getElementById('control-url').value;
    const pollInterval = parseInt(document.getElementById('poll-interval').value);

    if (!controlUrl) {
        alert('Please enter a control server URL');
        return;
    }

    await chrome.storage.sync.set({ controlUrl, pollInterval });

    // Start polling
    chrome.runtime.sendMessage({ 
        type: "start_polling",
        controlUrl,
        pollInterval
    }, response => {
        document.getElementById('status').textContent = `Status: ${response.status}`;
    });
});

document.getElementById('stop-polling').addEventListener('click', () => {
    chrome.runtime.sendMessage({ type: "stop_polling" }, response => {
        document.getElementById('status').textContent = `Status: ${response.status}`;
    });
});

document.getElementById('clear-settings').addEventListener('click', async () => {
    await chrome.storage.sync.clear();
    document.getElementById('control-url').value = '';
    document.getElementById('poll-interval').value = '30';
    document.getElementById('status').textContent = 'Status: Settings cleared';
});