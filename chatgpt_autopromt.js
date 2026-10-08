// ==UserScript==
// @name         ChatGPT Auto-Prompt (Image Aware & Header Status)
// @namespace    http://tampermonkey.net/
// @version      6.0
// @description  Adds 120-180s breaks, image detection delays, and live header status.
// @author       Assistant
// @match        https://chatgpt.com/*
// @grant        none
// ==/UserScript==

(function() {
    'use strict';

    // --- 1. Data Initialization ---
    let promptQueue = JSON.parse(localStorage.getItem('skipeon_active_queue')) || [];
    let panelPos = JSON.parse(localStorage.getItem('skipeon_panel_pos')) || { top: '10px', right: '10px' };

    let prePromptValue = localStorage.getItem('skipeon_pre_prompt') || "";
    let delayAfterX = parseInt(localStorage.getItem('skipeon_delay_x')) || 5;
    let delayMin = parseInt(localStorage.getItem('skipeon_delay_min')) || 120; // Default 120s
    let delayMax = parseInt(localStorage.getItem('skipeon_delay_max')) || 180; // Default 180s

    let isMinimized = localStorage.getItem('skipeon_minimized') === 'true';
    let isRunning = false;
    let promptsSentInBatch = 0;
    let isAfterBreak = true;

    // --- 2. Inject Styles ---
    const style = document.createElement('style');
    style.innerHTML = `
        #skipeon-panel {
            position: fixed; top: ${panelPos.top}; left: ${panelPos.left || 'auto'}; right: ${panelPos.right || '10px'};
            width: 340px; background: #ffffff; z-index: 99999;
            border-radius: 12px; box-shadow: 0 10px 30px rgba(0,0,0,0.3);
            display: flex; flex-direction: column; font-family: -apple-system, system-ui, sans-serif;
            border: 1px solid #d1d1d1; overflow: hidden; color: #333;
        }
        #skipeon-header {
            background: #10a37f; color: white; padding: 10px 12px; cursor: move;
            display: flex; justify-content: space-between; align-items: center;
            font-weight: bold; font-size: 13px; user-select: none;
        }
        #header-status { font-weight: normal; font-size: 11px; background: rgba(0,0,0,0.2); padding: 2px 6px; border-radius: 4px; margin-right: 5px; }
        #skipeon-body { padding: 15px; display: ${isMinimized ? 'none' : 'flex'}; flex-direction: column; gap: 8px; max-height: 80vh; overflow-y: auto; }
        textarea, input { width: 100%; padding: 8px; border: 1px solid #ddd; border-radius: 6px; font-size: 12px; box-sizing: border-box; }
        .config-row { display: flex; gap: 5px; align-items: center; font-size: 11px; color: #666; }
        .config-row input { width: 45px; text-align: center; padding: 4px; }
        #queue-viewer { flex-grow: 1; overflow-y: auto; background: #f9f9f9; border: 1px solid #eee; border-radius: 6px; padding: 5px; min-height: 80px; max-height: 150px; }
        .queue-item { font-size: 11px; padding: 5px; border-bottom: 1px solid #eee; background: white; display: flex; justify-content: space-between; }
        .btn { padding: 10px; border: none; border-radius: 6px; cursor: pointer; font-weight: 600; width: 100%; }
        .btn-start { background: #10a37f; color: white; }
        .btn-stop { background: #d9534f; color: white; display: none; }
        .status-active { background: #ff9800 !important; color: white; }
    `;
    document.head.appendChild(style);

    // --- 3. Build UI ---
    const panel = document.createElement('div');
    panel.id = 'skipeon-panel';
    panel.innerHTML = `
        <div id="skipeon-header">
            <div style="display:flex; align-items:center; overflow:hidden;">
                <span id="header-status">IDLE</span>
                <span style="white-space:nowrap;">Skipeon</span>
            </div>
            <button id="skipeon-toggle" style="background:none; border:none; color:white; cursor:pointer; font-size:16px;">${isMinimized ? '□' : '—'}</button>
        </div>
        <div id="skipeon-body">
            <label style="font-size:11px; font-weight:bold;">Pre-prompt (Post-break/Start):</label>
            <textarea id="pre-prompt-input" rows="2" placeholder="Instructions...">${prePromptValue}</textarea>

            <label style="font-size:11px; font-weight:bold;">Break Settings:</label>
            <div class="config-row">
                Every <input type="number" id="delay-x" value="${delayAfterX}"> prompts,
                wait <input type="number" id="delay-min" value="${delayMin}"> to <input type="number" id="delay-max" value="${delayMax}">s.
            </div>

            <textarea id="prompt-input" rows="2" placeholder="Add prompt to queue..."></textarea>
            <button id="add-q" class="btn" style="background:#f0f0f0; color:#333; border:1px solid #ccc; height:30px; padding:0;">+ Add</button>

            <div id="queue-viewer"></div>

            <button id="action-start" class="btn btn-start">START AUTO-PROMPT</button>
            <button id="action-stop" class="btn btn-stop">STOP / RELOAD</button>
        </div>
    `;
    document.body.appendChild(panel);

    const headerStatus = document.getElementById('header-status');
    const btnStart = document.getElementById('action-start');
    const btnStop = document.getElementById('action-stop');

    // --- 4. Logic Functions ---

    function setStatus(text, active = false) {
        headerStatus.innerText = text;
        if (active) headerStatus.classList.add('status-active');
        else headerStatus.classList.remove('status-active');
    }

    function isBusy() {
        const stopBtn = document.querySelector('button[aria-label="Stop generating"], button[data-testid$="stop-button"]');
        if (stopBtn) return true;
        const voiceBtn = document.querySelector('button[aria-label="Start Voice"]');
        const sendBtn = document.querySelector('button[data-testid$="send-button"]');
        if (voiceBtn) return false;
        if (sendBtn && !sendBtn.disabled) return false;
        return true;
    }

    // Detect if the latest message was an image generation
    function lastMessageWasImage() {
        const messages = document.querySelectorAll('div[data-testid^="conversation-turn"]');
        if (messages.length === 0) return false;
        const lastMsg = messages[messages.length - 1];
        // Check for common image indicators in ChatGPT's DOM
        return !!lastMsg.querySelector('img[src*="blob:"], div.grid-cols-2, [aria-label="Generated image"]');
    }

    async function mainLoop() {
        promptsSentInBatch = 0;
        isAfterBreak = true;

        while (isRunning && promptQueue.length > 0) {

            // 1. Break Logic (Long Delay)
            if (promptsSentInBatch >= delayAfterX) {
                const waitTime = Math.floor(Math.random() * (delayMax - delayMin + 1)) + delayMin;
                for (let i = waitTime; i > 0; i--) {
                    if (!isRunning) return;
                    setStatus(`☕ BREAK: ${i}s`, true);
                    await new Promise(r => setTimeout(r, 1000));
                }
                promptsSentInBatch = 0;
                isAfterBreak = true;
            }

            // 2. Busy Check
            if (isBusy()) {
                setStatus("⏳ BUSY...");
                await new Promise(r => setTimeout(r, 2000));
                continue;
            }

            // 3. Prepare Message
            const currentPre = document.getElementById('pre-prompt-input').value.trim();
            const nextPrompt = promptQueue.shift();
            let finalMsg = nextPrompt;
            if (isAfterBreak && currentPre) {
                finalMsg = currentPre + "\n\n" + nextPrompt;
                isAfterBreak = false;
            }

            // 4. Post
            setStatus("📤 SENDING...");
            const sent = await postPrompt(finalMsg);
            if (sent) {
                promptsSentInBatch++;
                syncStorage();
                updateQueueUI();

                // 5. Wait for Generation to Finish
                setStatus("💬 GENERATING...");
                await new Promise(r => setTimeout(r, 4000)); // Initial buffer
                while (isBusy()) {
                    await new Promise(r => setTimeout(r, 1000));
                }

                // 6. Image Awareness Logic
                if (lastMessageWasImage()) {
                    setStatus("🖼 IMAGE DETECTED (Syncing...)", true);
                    await new Promise(r => setTimeout(r, 15000)); // Extra 15s for image metadata to settle
                }

                setStatus("✅ READY");
                await new Promise(r => setTimeout(r, 2000));
            } else {
                promptQueue.unshift(nextPrompt);
                setStatus("❌ RETRYING...");
                await new Promise(r => setTimeout(r, 5000));
            }
        }

        if (promptQueue.length === 0) {
            isRunning = false;
            setStatus("COMPLETED");
            btnStart.style.display = 'block'; btnStop.style.display = 'none';
        }
    }

    async function postPrompt(text) {
        // 1. Locate the ProseMirror editor (found in your HTML dump)
        const editor = document.querySelector('div[contenteditable="true"].ProseMirror') || 
                    document.querySelector('div[aria-label="Ask ChatGPT"]');
        
        if (!editor) {
            console.error("Skipeon: Could not find the input editor.");
            return false;
        }

        // 2. Focus and Clear
        editor.focus();
        // We use selectAll + delete to ensure ProseMirror's internal 
        // document model is reset correctly.
        document.execCommand('selectAll', false, null);
        document.execCommand('delete', false, null);

        // 3. Insert Text via execCommand
        // This is the "magic" step that makes the Send button light up.
        const success = document.execCommand('insertText', false, text);
        
        // 4. Dispatch events to notify the UI
        editor.dispatchEvent(new Event('input', { bubbles: true }));
        editor.dispatchEvent(new Event('change', { bubbles: true }));

        // 5. Short wait for the Send button to become enabled in the DOM
        await new Promise(r => setTimeout(r, 800));

        // 6. Find the Send button
        // In your HTML, it's often dynamically swapped with the "Voice" button.
        // We look for the Send label specifically.
        const sendBtn = document.querySelector('button[data-testid="send-button"]') || 
                        document.querySelector('button[aria-label="Send prompt"]');

        if (sendBtn && !sendBtn.disabled) {
            sendBtn.click();
            return true;
        } else {
            // 7. FALLBACK: If the button is disabled/missing, simulate the Enter key.
            // This works on the ProseMirror editor even if the button isn't ready.
            const enterEvent = new KeyboardEvent('keydown', {
                key: 'Enter',
                code: 'Enter',
                keyCode: 13,
                which: 13,
                bubbles: true,
                cancelable: true
            });
            editor.dispatchEvent(enterEvent);
            return true;
        }
    }
    // async function postPrompt(text) {
    //     const textArea = document.querySelector('.ProseMirror');
    //     if (!textArea) return false;
    //     textArea.focus();
    //     document.execCommand('selectAll', false, null);
    //     document.execCommand('delete', false, null);
    //     document.execCommand('insertText', false, text);
    //     textArea.dispatchEvent(new Event('input', { bubbles: true }));
    //     await new Promise(r => setTimeout(r, 5000));
    //     const sendBtn = document.querySelector('button[data-testid$="send-button"]');
    //     if (sendBtn && !sendBtn.disabled) {
    //         sendBtn.click();
    //         return true;
    //     }
    //     return false;
    // }

    // --- 5. UI Helpers ---

    function syncStorage() {
        localStorage.setItem('skipeon_active_queue', JSON.stringify(promptQueue));
        localStorage.setItem('skipeon_pre_prompt', document.getElementById('pre-prompt-input').value);
        localStorage.setItem('skipeon_delay_x', document.getElementById('delay-x').value);
        localStorage.setItem('skipeon_delay_min', document.getElementById('delay-min').value);
        localStorage.setItem('skipeon_delay_max', document.getElementById('delay-max').value);
    }

    function updateQueueUI() {
        const qv = document.getElementById('queue-viewer');
        qv.innerHTML = '';
        promptQueue.forEach((p, i) => {
            const item = document.createElement('div');
            item.className = 'queue-item';
            item.innerHTML = `<span>${i+1}. ${p.substring(0,35)}...</span><span style="color:red;cursor:pointer;" onclick="window.delItem(${i})">×</span>`;
            qv.appendChild(item);
        });
    }

    window.delItem = (i) => { promptQueue.splice(i, 1); syncStorage(); updateQueueUI(); };

    document.getElementById('add-q').onclick = () => {
        const val = document.getElementById('prompt-input').value.trim();
        if(val){ promptQueue.push(val); document.getElementById('prompt-input').value = ''; syncStorage(); updateQueueUI(); }
    };

    btnStart.onclick = () => {
        if(promptQueue.length === 0) return;
        isRunning = true;
        btnStart.style.display = 'none';
        btnStop.style.display = 'block';
        delayAfterX = parseInt(document.getElementById('delay-x').value);
        delayMin = parseInt(document.getElementById('delay-min').value);
        delayMax = parseInt(document.getElementById('delay-max').value);
        syncStorage();
        mainLoop();
    };

    btnStop.onclick = () => location.reload();

    document.getElementById('skipeon-toggle').onclick = () => {
        isMinimized = !isMinimized;
        document.getElementById('skipeon-body').style.display = isMinimized ? 'none' : 'flex';
        document.getElementById('skipeon-toggle').innerText = isMinimized ? '□' : '—';
        localStorage.setItem('skipeon_minimized', isMinimized);
    };

    const header = document.getElementById('skipeon-header');
    header.onmousedown = (e) => {
        let pos3 = e.clientX, pos4 = e.clientY;
        document.onmousemove = (e) => {
            panel.style.top = (panel.offsetTop - (pos4 - e.clientY)) + "px";
            panel.style.left = (panel.offsetLeft - (pos3 - e.clientX)) + "px";
            pos3 = e.clientX; pos4 = e.clientY; panel.style.right = 'auto';
        };
        document.onmouseup = () => {
            document.onmousemove = null;
            localStorage.setItem('skipeon_panel_pos', JSON.stringify({top: panel.style.top, left: panel.style.left}));
        };
    };

    updateQueueUI();
})();
