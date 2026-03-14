// ── Help Modal ──
function openHelp() {
    document.getElementById('help-modal').classList.add('active');
}
function closeHelp() {
    document.getElementById('help-modal').classList.remove('active');
}
document.addEventListener('keydown', e => { if (e.key === 'Escape') closeHelp(); });

// ── Constants ──
const TWITCH_CLIENT_ID = '8bg8a5nnibxhf2w9uq6oiv0m71plux';
const LS_TOKEN = 'ar_twitch_token';
const LS_USERNAME = 'ar_twitch_user';
const LS_PROFILES = 'ar_profiles';
const LS_MODEL = 'ar_ai_model';
const IRC_URL = 'wss://irc-ws.chat.twitch.tv:443';

const MODELS = {
    "qwen": {
        id: "Qwen2.5-0.5B-Instruct-q4f16_1-MLC",
        label: "Qwen 2.5 0.5B (Smallest)",
        description: "Smallest & fastest. Ideal for basic tasks.",
        warning: ""
    },
    "llama1b": {
        id: "Llama-3.2-1B-Instruct-q4f16_1-MLC",
        label: "Llama 3.2 1B (Fast)",
        description: "Great for basic chat. ~750 MB download.",
        warning: ""
    },
    "gemma2": {
        id: "gemma-2-2b-it-q4f16_1-MLC",
        label: "Gemma-2 2B (Reliable)",
        description: "Very reliable performance. ~1.6 GB download.",
        warning: "⚠️ Warning: Requires a decent GPU."
    },
    "phi3": {
        id: "Phi-3.5-mini-instruct-q4f16_1-MLC",
        label: "Phi-3.5 Mini (Smart)",
        description: "Stronger reasoning capabilities. ~2.2 GB download.",
        warning: "⚠️ Warning: Heavier than Gemma."
    },
    "llama8b": {
        id: "Llama-3.1-8B-Instruct-q4f32_1-MLC",
        label: "Llama 3.1 8B (Quality)",
        description: "High quality intelligence. ~5.0 GB download.",
        warning: "⚠️ Warning: Requires a good GPU (6GB+ VRAM)."
    }
};

// ── State ──
let accessToken = '';
let username = '';
let userId = ''; // Authenticated user's Twitch ID (for Helix API)
let userIdCache = {}; // channelName -> userId cache
let profiles = {}; // { channelName: { triggers: [ { phrase, prePrompt, useCounter, counterStart, counterValue } ] } }
let selectedChannel = null;
let ircSocket = null;
let ircConnected = false;
let joinedChannels = new Set();
let reconnectTimer = null;
let lastSentMessages = {}; // channelName -> lastMsg (to avoid duplicate blocks)
let currentModelKey = localStorage.getItem(LS_MODEL) || "qwen";

// ── Init ──
window.addEventListener('DOMContentLoaded', () => {
    checkOAuthReturn();
});

// ── OAuth ──
function loginWithTwitch() {
    const redirectUri = window.location.origin + window.location.pathname;
    const scopes = 'user:read:email chat:read chat:edit user:write:chat user:bot';
    const authUrl = 'https://id.twitch.tv/oauth2/authorize'
        + '?client_id=' + encodeURIComponent(TWITCH_CLIENT_ID)
        + '&redirect_uri=' + encodeURIComponent(redirectUri)
        + '&response_type=token'
        + '&scope=' + encodeURIComponent(scopes)
        + '&force_verify=true';
    window.location.href = authUrl;
}

async function checkOAuthReturn() {
    const hash = window.location.hash;
    if (hash && hash.includes('access_token=')) {
        const params = new URLSearchParams(hash.substring(1));
        const token = params.get('access_token');
        if (token) {
            accessToken = token;
            localStorage.setItem(LS_TOKEN, token);
            history.replaceState(null, '', window.location.pathname + window.location.search);
            await fetchUsername();
            enterDashboard();
            return;
        }
    }

    // Check stored token
    const stored = localStorage.getItem(LS_TOKEN);
    const storedUser = localStorage.getItem(LS_USERNAME);
    if (stored) {
        accessToken = stored;
        if (storedUser) username = storedUser;
        // Validate token
        try {
            const res = await fetch('https://id.twitch.tv/oauth2/validate', {
                headers: { 'Authorization': `OAuth ${accessToken}` }
            });
            if (res.ok) {
                if (!username) await fetchUsername();
                enterDashboard();
                return;
            } else {
                // Token expired
                localStorage.removeItem(LS_TOKEN);
                localStorage.removeItem(LS_USERNAME);
            }
        } catch (e) {
            // Offline, try anyway
            if (username) {
                enterDashboard();
                return;
            }
        }
    }

    // Show login
    showLogin();
}

async function fetchUsername() {
    try {
        const res = await fetch('https://api.twitch.tv/helix/users', {
            headers: {
                'Client-ID': TWITCH_CLIENT_ID,
                'Authorization': `Bearer ${accessToken}`,
            },
        });
        if (res.ok) {
            const data = await res.json();
            if (data.data && data.data.length > 0) {
                username = data.data[0].login;
                userId = data.data[0].id;
                localStorage.setItem(LS_USERNAME, username);
                localStorage.setItem('ar_twitch_user_id', userId);
                userIdCache[username.toLowerCase()] = userId;
            }
        }
    } catch (e) {
        console.warn('Could not fetch username:', e);
    }
}

// Resolve a channel name to a Twitch user ID (cached)
async function resolveUserId(channelName) {
    const key = channelName.toLowerCase();
    if (userIdCache[key]) return userIdCache[key];
    try {
        const res = await fetch(`https://api.twitch.tv/helix/users?login=${encodeURIComponent(key)}`, {
            headers: {
                'Client-ID': TWITCH_CLIENT_ID,
                'Authorization': `Bearer ${accessToken}`,
            },
        });
        if (res.ok) {
            const data = await res.json();
            if (data.data && data.data.length > 0) {
                userIdCache[key] = data.data[0].id;
                return data.data[0].id;
            }
        }
    } catch (e) {
        console.warn('Could not resolve user ID for:', channelName, e);
    }
    return null;
}

function logout() {
    accessToken = '';
    username = '';
    localStorage.removeItem(LS_TOKEN);
    localStorage.removeItem(LS_USERNAME);
    disconnectIRC();
    showLogin();
}

// ── Screens ──
function showLogin() {
    document.getElementById('login-screen').classList.add('active');
    document.getElementById('dashboard').classList.remove('active');
}

function enterDashboard() {
    document.getElementById('login-screen').classList.remove('active');
    document.getElementById('dashboard').classList.add('active');
    document.getElementById('user-name').textContent = username || 'Connected';
    // Restore userId from localStorage if needed
    if (!userId) {
        userId = localStorage.getItem('ar_twitch_user_id') || '';
    }
    loadProfiles();
    renderChannelList();
    connectIRC();
}

// ── Profiles (localStorage) ──
function loadProfiles() {
    try {
        const saved = localStorage.getItem(LS_PROFILES);
        if (saved) profiles = JSON.parse(saved);
    } catch (e) {
        profiles = {};
    }
}

function saveProfiles() {
    localStorage.setItem(LS_PROFILES, JSON.stringify(profiles));
    if (ircConnected) {
        if (typeof aiReady !== 'undefined' && aiReady) {
            const channelCount = Object.keys(profiles).length;
            const triggerCount = Object.values(profiles).reduce((sum, p) => sum + p.triggers.filter(t => t.phrase).length, 0);
            updateMonitorStatus(`Connected — monitoring ${channelCount} channel${channelCount !== 1 ? 's' : ''} with ${triggerCount} trigger${triggerCount !== 1 ? 's' : ''} (AI Ready)`);
        } else {
            updateConnectionUI('connected');
        }
    }
}

// ── Channel Management ──
function addChannel() {
    const input = document.getElementById('add-channel-input');
    const name = input.value.trim().toLowerCase().replace(/^#/, '');
    if (!name) return;
    if (profiles[name]) {
        selectChannel(name);
        input.value = '';
        return;
    }
    profiles[name] = { triggers: [] };
    saveProfiles();
    renderChannelList();
    selectChannel(name);
    input.value = '';

    // Join channel in IRC
    if (ircConnected) {
        joinChannel(name);
    }
}

function removeChannel(name, event) {
    event.stopPropagation();
    if (!confirm(`Remove channel #${name} and all its triggers?`)) return;
    delete profiles[name];
    saveProfiles();
    if (selectedChannel === name) {
        selectedChannel = null;
        renderTriggerEditor();
    }
    renderChannelList();
    if (ircConnected) leaveChannel(name);
}

function selectChannel(name) {
    selectedChannel = name;
    renderChannelList();
    renderTriggerEditor();
}

function renderChannelList() {
    const container = document.getElementById('channel-list');
    const channelNames = Object.keys(profiles);
    if (channelNames.length === 0) {
        container.innerHTML = '<div style="padding:1.5rem 0.75rem; text-align:center; color:var(--text-muted); font-size:0.82rem;">No channels added yet</div>';
        return;
    }
    container.innerHTML = channelNames.map(name => {
        const triggerCount = profiles[name].triggers.length;
        const isActive = name === selectedChannel;
        const isPaused = profiles[name].paused;
        return `
          <div class="channel-item ${isActive ? 'active' : ''} ${isPaused ? 'paused' : ''}" onclick="selectChannel('${name}')">
            <div class="channel-info">
              <div class="channel-icon">${name.charAt(0)}</div>
              <div class="channel-name">${name}${isPaused ? '<span class="paused-badge">PAUSED</span>' : ''}</div>
            </div>
            <div style="display:flex; align-items:center; gap:0.4rem;">
              <span class="channel-trigger-count">${triggerCount}</span>
              <button class="btn btn-icon btn-ghost channel-remove" onclick="removeChannel('${name}', event)" title="Remove">×</button>
            </div>
          </div>
        `;
    }).join('');
}

// ── Trigger Management ──
function renderTriggerEditor() {
    const noMsg = document.getElementById('no-channel-msg');
    const editor = document.getElementById('trigger-editor');

    if (!selectedChannel || !profiles[selectedChannel]) {
        noMsg.style.display = 'flex';
        editor.style.display = 'none';
        return;
    }

    noMsg.style.display = 'none';
    editor.style.display = 'block';
    document.getElementById('selected-channel-name').textContent = selectedChannel;

    const triggers = profiles[selectedChannel].triggers;
    const list = document.getElementById('trigger-list');
    const empty = document.getElementById('empty-triggers');

    if (triggers.length === 0) {
        list.innerHTML = '';
        empty.style.display = 'block';
        return;
    }

    empty.style.display = 'none';

    // Update channel pause button
    const pauseBtn = document.getElementById('channel-pause-btn');
    if (profiles[selectedChannel].paused) {
        pauseBtn.className = 'btn btn-success';
        pauseBtn.innerHTML = '▶ Resume Channel';
    } else {
        pauseBtn.className = 'btn btn-warning';
        pauseBtn.innerHTML = '⏸ Pause Channel';
    }

    list.innerHTML = triggers.map((t, i) => {
        const counterClass = t.useCounter ? 'active' : '';
        const anywhereClass = t.matchAnywhere ? 'active' : '';
        const enabledClass = (t.enabled !== false) ? 'active' : '';
        const cardDisabled = (t.enabled === false) ? 'disabled' : '';
        const counterDisplay = t.useCounter ? '' : 'display:none;';
        return `
          <div class="trigger-card ${cardDisabled}" id="trigger-${i}">
            <div class="trigger-row">
              <div class="trigger-field" style="flex:0.4; min-width:120px;">
                <label>Trigger Phrase</label>
                <input type="text" value="${escapeAttr(t.phrase)}" placeholder="!command"
                  onchange="updateTrigger(${i}, 'phrase', this.value)">
              </div>
              <div class="trigger-field" style="flex:1;">
                <label>AI Pre-prompt (use {author}, {message}, {count}, {channel})</label>
                <textarea style="width:100%; height:100px; font-family:inherit; font-size:0.85rem; padding:0.6rem; border-radius:6px; background:var(--surface2); border:1px solid var(--border); color:var(--text); resize:vertical;"
                  placeholder="e.g. The user {author} says: {message}. Give a sassy response in 1 sentence. Count is {count}."
                  onchange="updateTrigger(${i}, 'prePrompt', this.value)">${escapeAttr(t.prePrompt || '')}</textarea>
                <div style="font-size:0.65rem; color:var(--text-muted); margin-top:0.4rem; display:flex; gap:0.8rem; flex-wrap:wrap;">
                  <span><code style="color:var(--accent);">{author}</code> Sender</span>
                  <span><code style="color:var(--accent);">{message}</code> Message</span>
                  <span><code style="color:var(--accent);">{count}</code> Counter</span>
                  <span><code style="color:var(--accent);">{channel}</code> Channel</span>
                </div>
              </div>
            </div>
            <div class="trigger-row" style="margin-top:0.6rem;">
              <div class="trigger-field" style="flex:1;">
                <label>Cooldown (seconds)</label>
                <input type="number" value="${t.cooldown || 0}" min="0" placeholder="0"
                  onchange="updateTrigger(${i}, 'cooldown', parseInt(this.value) || 0)">
              </div>
              <div class="trigger-field" style="flex:1;">
                <label>Delay (seconds)</label>
                <input type="number" value="${t.delay || 0}" min="0" placeholder="0"
                  onchange="updateTrigger(${i}, 'delay', parseInt(this.value) || 0)">
              </div>
            </div>
            <div class="trigger-row" style="margin-top:0.6rem;">
              <div class="trigger-field">
                <label>Allowed Users <span style="font-weight:400; opacity:0.6;">(comma-separated, empty = everyone)</span></label>
                <input type="text" value="${escapeAttr(t.allowedUsers || '')}" placeholder="user1, user2, user3"
                  onchange="updateTrigger(${i}, 'allowedUsers', this.value)">
              </div>
            </div>
            <div class="trigger-row" style="margin-top:0.6rem;">
              <div class="trigger-field">
                <label>Disallowed Users <span style="font-weight:400; opacity:0.6;">(ignore these accounts)</span></label>
                <input type="text" value="${escapeAttr(t.disallowedUsers || '')}" placeholder="bot1, troll2"
                  onchange="updateTrigger(${i}, 'disallowedUsers', this.value)">
              </div>
            </div>
            <div class="trigger-bottom">
              <div class="counter-section">
                <div class="toggle-wrapper" onclick="toggleTriggerEnabled(${i})">
                  <div class="toggle ${enabledClass}"></div>
                  <span>Active</span>
                </div>
                <div class="toggle-wrapper" onclick="toggleCounter(${i})">
                  <div class="toggle ${counterClass}"></div>
                  <span>Counter</span>
                </div>
                <div class="toggle-wrapper" onclick="toggleMatchAnywhere(${i})" title="Trigger if word is anywhere in message">
                  <div class="toggle ${t.matchAnywhere ? 'active' : ''}"></div>
                  <span>Anywhere</span>
                </div>
                <div class="counter-start" style="${counterDisplay}" id="counter-opts-${i}">
                  <label>Start:</label>
                  <input type="number" value="${t.counterStart || 0}"
                    onchange="updateTrigger(${i}, 'counterStart', parseInt(this.value) || 0)">
                  <span class="counter-current" title="Current counter value">Now: ${t.counterValue ?? t.counterStart ?? 0}</span>
                  <button class="btn btn-ghost" style="font-size:0.7rem; padding:0.2rem 0.4rem;"
                    onclick="resetCounter(${i})" title="Reset counter to start value">↺</button>
                </div>
              </div>
              <button class="btn btn-danger btn-icon" onclick="removeTrigger(${i})" title="Delete trigger"
                style="font-size:0.85rem;">✕</button>
            </div>
          </div>
        `;
    }).join('');
}

function addTrigger() {
    if (!selectedChannel) return;
    profiles[selectedChannel].triggers.push({
        phrase: '',
        prePrompt: '',
        allowedUsers: '',
        disallowedUsers: '',
        matchAnywhere: false,
        cooldown: 0,
        delay: 0,
        enabled: true,
        useCounter: false,
        counterStart: 0,
        counterValue: 0,
    });
    saveProfiles();
    renderTriggerEditor();
    renderChannelList();
}

function removeTrigger(index) {
    if (!selectedChannel) return;
    profiles[selectedChannel].triggers.splice(index, 1);
    saveProfiles();
    renderTriggerEditor();
    renderChannelList();
}

function updateTrigger(index, field, value) {
    if (!selectedChannel) return;
    const t = profiles[selectedChannel].triggers[index];
    if (!t) return;
    t[field] = value;
    saveProfiles();
    // Only re-render if counter visibility changed
    if (field === 'useCounter') renderTriggerEditor();
}


function togglePauseChannel() {
    if (!selectedChannel) return;
    profiles[selectedChannel].paused = !profiles[selectedChannel].paused;
    saveProfiles();
    renderTriggerEditor();
    renderChannelList();
    addLogEntry('info', `${profiles[selectedChannel].paused ? 'Paused' : 'Resumed'} monitoring for <span class="log-channel">#${selectedChannel}</span>`);
}

function toggleTriggerEnabled(index) {
    if (!selectedChannel) return;
    const t = profiles[selectedChannel].triggers[index];
    if (!t) return;
    t.enabled = (t.enabled === false) ? true : false;
    saveProfiles();
    renderTriggerEditor();
}

function toggleCounter(index) {
    if (!selectedChannel) return;
    const t = profiles[selectedChannel].triggers[index];
    if (!t) return;
    t.useCounter = !t.useCounter;
    if (t.useCounter && t.counterValue === undefined) {
        t.counterValue = t.counterStart || 0;
    }
    saveProfiles();
    renderTriggerEditor();
}

function toggleMatchAnywhere(index) {
    if (!selectedChannel) return;
    const t = profiles[selectedChannel].triggers[index];
    if (!t) return;
    t.matchAnywhere = !t.matchAnywhere;
    saveProfiles();
    renderTriggerEditor();
}

function resetCounter(index) {
    if (!selectedChannel) return;
    const t = profiles[selectedChannel].triggers[index];
    if (!t) return;
    t.counterValue = t.counterStart || 0;
    saveProfiles();
    renderTriggerEditor();
}

function escapeAttr(str) {
    if (!str) return '';
    return str.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// ── IRC WebSocket ──
function connectIRC() {
    if (ircSocket && (ircSocket.readyState === WebSocket.CONNECTING || ircSocket.readyState === WebSocket.OPEN)) {
        return;
    }

    updateConnectionUI('connecting');
    addLogEntry('info', 'Connecting to Twitch IRC…');

    ircSocket = new WebSocket(IRC_URL);

    ircSocket.onopen = () => {
        ircSocket.send(`PASS oauth:${accessToken}`);
        ircSocket.send(`NICK ${username}`);

        // Join all configured channels
        Object.keys(profiles).forEach(ch => joinChannel(ch));

        ircConnected = true;
        updateConnectionUI('connected');
        addLogEntry('info', 'Connected to Twitch IRC ✓');
    };

    ircSocket.onmessage = (event) => {
        const lines = event.data.split('\r\n');
        lines.forEach(line => {
            if (!line) return;

            // PING/PONG keepalive
            if (line.startsWith('PING')) {
                ircSocket.send('PONG :tmi.twitch.tv');
                return;
            }

            // Log raw IRC for debugging (to browser console)
            console.log('[IRC]', line);

            // Parse PRIVMSG — use permissive regex for username/host
            const privmsgMatch = line.match(/^:([^!]+)!\S+ PRIVMSG #(\S+) :(.+)$/i);
            if (privmsgMatch) {
                const [, sender, channel, message] = privmsgMatch;
                handleChatMessage(sender.toLowerCase(), channel.toLowerCase(), message.trim());
            }

            // Log auth/join failures
            if (line.includes('Login authentication failed')) {
                addLogEntry('error', 'Authentication failed — token may be expired. Try logging out and back in.');
            }
            if (line.includes('NOTICE') && line.includes('improperly formatted')) {
                addLogEntry('error', 'IRC message format error — check console for details.');
            }
        });
    };

    ircSocket.onclose = () => {
        ircConnected = false;
        joinedChannels.clear();
        updateConnectionUI('disconnected');
        addLogEntry('error', 'Disconnected from Twitch IRC');

        // Auto-reconnect after 5s
        if (accessToken) {
            reconnectTimer = setTimeout(() => {
                addLogEntry('info', 'Attempting reconnect…');
                connectIRC();
            }, 5000);
        }
    };

    ircSocket.onerror = (err) => {
        console.error('IRC error:', err);
        addLogEntry('error', 'IRC connection error');
    };
}

function disconnectIRC() {
    if (reconnectTimer) {
        clearTimeout(reconnectTimer);
        reconnectTimer = null;
    }
    if (ircSocket) {
        ircSocket.close();
        ircSocket = null;
    }
    ircConnected = false;
    joinedChannels.clear();
    updateConnectionUI('disconnected');
}

function joinChannel(name) {
    if (!ircSocket || ircSocket.readyState !== WebSocket.OPEN) return;
    if (joinedChannels.has(name)) return;
    ircSocket.send(`JOIN #${name}`);
    joinedChannels.add(name);
    addLogEntry('info', `Joined <span class="log-channel">#${name}</span>`);
}

function leaveChannel(name) {
    if (!ircSocket || ircSocket.readyState !== WebSocket.OPEN) return;
    ircSocket.send(`PART #${name}`);
    joinedChannels.delete(name);
    addLogEntry('info', `Left <span class="log-channel">#${name}</span>`);
}

// Send message via Twitch Helix API (more reliable than IRC PRIVMSG)
async function sendMessage(channel, message) {
    const broadcasterId = await resolveUserId(channel);
    if (!broadcasterId) {
        addLogEntry('error', `Could not resolve user ID for <span class="log-channel">#${channel}</span>`);
        return false;
    }
    if (!userId) {
        addLogEntry('error', 'Sender user ID not available. Try logging out and back in.');
        return false;
    }
    let finalMessage = message;
    if (lastSentMessages[channel] === message) {
        finalMessage += ' ⠀'; // Append braille space to bypass duplicate filter
    }

    try {
        const res = await fetch('https://api.twitch.tv/helix/chat/messages', {
            method: 'POST',
            headers: {
                'Client-ID': TWITCH_CLIENT_ID,
                'Authorization': `Bearer ${accessToken}`,
                'Content-Type': 'application/json',
            },
            body: JSON.stringify({
                broadcaster_id: broadcasterId,
                sender_id: userId,
                message: finalMessage,
            }),
        });
        if (res.ok) {
            lastSentMessages[channel] = message; // Store original message for next check
            return true;
        } else {
            const err = await res.json().catch(() => ({}));
            console.error('[AutoChatter] Send failed:', res.status, err);
            addLogEntry('error',
                `Send failed (${res.status}): ${err.message || err.error || 'Unknown error'} — ` +
                `<span class="log-channel">#${channel}</span>`
            );
            return false;
        }
    } catch (e) {
        console.error('[AutoChatter] Send error:', e);
        addLogEntry('error', `Network error sending to <span class="log-channel">#${channel}</span>: ${e.message}`);
        return false;
    }
}

// ── Message Handling ──
async function handleChatMessage(sender, channel, message) {
    // Don't respond to ourselves
    if (sender.toLowerCase() === username.toLowerCase()) return;

    // Log ALL incoming chat messages to the activity panel
    addLogEntry('chat',
        `<span class="log-channel">#${channel}</span> ` +
        `<span class="log-user">${escapeHtml(sender)}</span>: ` +
        `${escapeHtml(message)}`
    );

    const profile = profiles[channel];
    if (!profile || profile.paused) return;

    const msgLower = message.toLowerCase().trim();

    for (const trigger of profile.triggers) {
        if (!trigger.phrase || trigger.enabled === false) continue;

        const phraseLower = trigger.phrase.toLowerCase().trim();
        // Match logic: 'Anywhere' or 'Starts with' (includes exact match)
        const isMatch = trigger.matchAnywhere
            ? msgLower.includes(phraseLower)
            : (msgLower === phraseLower || msgLower.startsWith(phraseLower + ' '));

        if (isMatch) {
            // Check allowed users filter
            if (trigger.allowedUsers && trigger.allowedUsers.trim()) {
                const allowed = trigger.allowedUsers.toLowerCase().split(',').map(u => u.trim()).filter(u => u);
                if (allowed.length > 0 && !allowed.includes(sender.toLowerCase())) {
                    // User not in allowlist, skip
                    continue;
                }
            }

            // Check disallowed users filter
            if (trigger.disallowedUsers && trigger.disallowedUsers.trim()) {
                const disallowed = trigger.disallowedUsers.toLowerCase().split(',').map(u => u.trim()).filter(u => u);
                if (disallowed.includes(sender.toLowerCase())) {
                    // User is blacklisted, skip
                    continue;
                }
            }

            // Check cooldown (enforce min 0.5s to avoid loops)
            const now = Date.now();
            const cooldownMs = Math.max(500, (trigger.cooldown || 0) * 1000);
            if (trigger.lastTriggered && (now - trigger.lastTriggered) < cooldownMs) {
                // Still on cooldown
                if (trigger.cooldown > 0) {
                    const remaining = Math.ceil((cooldownMs - (now - trigger.lastTriggered)) / 1000);
                    console.log(`[AutoChatter] Trigger "${trigger.phrase}" on cooldown. ${remaining}s left.`);
                }
                continue;
            }
            trigger.lastTriggered = now;

            // Match found!
            addLogEntry('match',
                `⚡ TRIGGER matched: ` +
                `<span class="log-user">${escapeHtml(sender)}</span> said ` +
                `<span class="log-phrase">${escapeHtml(trigger.phrase)}</span> in ` +
                `<span class="log-channel">#${channel}</span>`
            );

            addLogEntry('info', `🤖 Processing AI response for <span class="log-user">${escapeHtml(sender)}</span>...`);

            let response = await generateAIResponse(trigger.prePrompt || '', {
                author: sender,
                message: message,
                count: trigger.useCounter ? (trigger.counterValue || trigger.counterStart || 0) + 1 : 0,
                channel: channel
            });

            if (!response) {
                addLogEntry('error', 'AI failed to generate a response.');
                continue;
            }

            // Handle counter (increment after AI potentially used the value)
            if (trigger.useCounter) {
                if (trigger.counterValue === undefined) {
                    trigger.counterValue = trigger.counterStart || 0;
                }
                trigger.counterValue++;
                saveProfiles();
                // Re-render if this channel is selected
                if (selectedChannel === channel) {
                    renderTriggerEditor();
                }
            }

            if (response) {
                // Wait for configured delay
                if (trigger.delay > 0) {
                    await new Promise(resolve => setTimeout(resolve, trigger.delay * 1000));
                }
                const sent = await sendMessage(channel, response);
                if (sent) {
                    addLogEntry('sent',
                        `→ <span class="log-channel">#${channel}</span>: ${escapeHtml(response)}`
                    );
                } else {
                    addLogEntry('error',
                        `Failed to send response to <span class="log-channel">#${channel}</span> (socket not open)`
                    );
                }
            }
            break; // Only trigger the first match
        }
    }
}


// ── Activity Log ──
function addLogEntry(type, html) {
    const log = document.getElementById('activity-log');
    const empty = document.getElementById('activity-empty');
    if (empty) empty.style.display = 'none';

    const now = new Date();
    const time = now.toLocaleTimeString('en-US', { hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit' });

    const entry = document.createElement('div');
    entry.className = `log-entry ${type}`;
    entry.innerHTML = `<span class="log-time">${time}</span>${html}`;
    log.appendChild(entry);

    // Keep max 200 entries
    while (log.children.length > 201) {
        log.removeChild(log.children[1]); // skip empty placeholder
    }

    // Scroll to bottom
    log.scrollTop = log.scrollHeight;
}

function clearLog() {
    const log = document.getElementById('activity-log');
    log.innerHTML = '<div class="activity-empty" id="activity-empty">Waiting for activity…<br>Triggers will appear here in real-time.</div>';
}

function escapeHtml(str) {
    const div = document.createElement('div');
    div.textContent = str;
    return div.innerHTML;
}

// ── Connection UI ──
function updateConnectionUI(status) {
    const dot = document.getElementById('conn-dot');
    const monitorDot = document.getElementById('monitor-dot');
    const monitorStatus = document.getElementById('monitor-status');

    dot.className = 'connection-dot';
    monitorDot.className = 'connection-dot';

    const channelCount = Object.keys(profiles).length;
    const triggerCount = Object.values(profiles).reduce((sum, p) => sum + p.triggers.filter(t => t.phrase).length, 0);

    switch (status) {
        case 'connected':
            dot.classList.add('connected');
            dot.title = 'Connected';
            monitorDot.classList.add('connected');
            monitorStatus.textContent = `Connected — monitoring ${channelCount} channel${channelCount !== 1 ? 's' : ''} with ${triggerCount} trigger${triggerCount !== 1 ? 's' : ''}`;
            break;
        case 'connecting':
            dot.classList.add('connecting');
            dot.title = 'Connecting…';
            monitorDot.classList.add('connecting');
            monitorStatus.textContent = 'Connecting to Twitch IRC…';
            break;
        default:
            dot.title = 'Disconnected';
            monitorStatus.textContent = 'Not connected';
    }
}

// Re-update status bar when profiles change
function refreshMonitorStatus() {
    if (ircConnected) updateConnectionUI('connected');
}

// Override save to also refresh status



// AI Model Management
let aiEngine = null;
let aiLoading = false;
let aiReady = false;

async function initAI(forceReload = false) {
    if ((aiLoading || aiReady) && !forceReload) return;

    // Clean up existing engine if re-initializing
    if (aiEngine) {
        try {
            await aiEngine.unload();
            aiEngine = null;
        } catch (e) { console.warn("Unload error:", e); }
    }

    aiLoading = true;
    aiReady = false;
    const modelCfg = MODELS[currentModelKey] || MODELS["qwen"];
    updateMonitorStatus(`Loading ${modelCfg.label.split(' (')[0]}...`);

    try {
        const { MLCEngine } = await import("https://esm.run/@mlc-ai/web-llm");
        aiEngine = new MLCEngine();
        aiEngine.setInitProgressCallback((report) => {
            updateMonitorStatus(`AI Loading: ${Math.round(report.progress * 100)}%`);
        });
        await aiEngine.reload(modelCfg.id);
        aiReady = true;
        aiLoading = false;
        updateMonitorStatus(`AI ready: ${modelCfg.label.split(' (')[0]}`);
        addLogEntry('info', `AI Model (${modelCfg.label}) Loaded ✓`);
        refreshMonitorStatus();
    } catch (err) {
        aiLoading = false;
        console.error("AI Init Error:", err);
        updateMonitorStatus("AI Error: WebGPU not supported?");
        addLogEntry('error', 'Failed to load AI Model. Check WebGPU support.');
    }
}

function switchModel(modelKey) {
    if (!MODELS[modelKey]) return;
    if (currentModelKey === modelKey && aiReady) return;

    currentModelKey = modelKey;
    localStorage.setItem(LS_MODEL, modelKey);

    if (ircConnected) {
        addLogEntry('info', `Switching to model: ${MODELS[modelKey].label}...`);
    }

    initAI(true);
    renderModelSelection(); // Update UI if on login screen or settings
}

function renderModelSelection() {
    // Shared logic to update UI elements based on currentModelKey
    const loginSelect = document.getElementById('login-model-select');
    if (loginSelect) {
        loginSelect.value = currentModelKey;
        const warning = MODELS[currentModelKey].warning;
        const warningEl = document.getElementById('login-model-warning');
        if (warningEl) {
            warningEl.textContent = warning;
            warningEl.style.display = warning ? 'block' : 'none';
        }
    }
}

async function generateAIResponse(prePrompt, variables) {
    if (!aiReady) {
        addLogEntry('error', 'AI Model not ready. Please wait for it to load.');
        return null;
    }

    let prompt = prePrompt;
    for (const [key, value] of Object.entries(variables)) {
        const regex = new RegExp(`\\{${key}\\}`, 'gi');
        prompt = prompt.replace(regex, value);
    }

    try {
        const response = await aiEngine.chat.completions.create({
            messages: [{ role: "user", content: prompt }],
            temperature: 0.7,
        });
        return response.choices[0]?.message?.content?.trim() || null;
    } catch (err) {
        console.error("AI Generation Error:", err);
        addLogEntry('error', 'AI Generation failed: ' + err.message);
        return null;
    }
}

function updateMonitorStatus(text) {
    const statusEl = document.getElementById('monitor-status');
    if (statusEl) statusEl.textContent = text;
}

// Call initAI when dashboard enters
const _originalEnterDashboard = enterDashboard;
window.enterDashboard = function () {
    _originalEnterDashboard();
    initAI();
};

