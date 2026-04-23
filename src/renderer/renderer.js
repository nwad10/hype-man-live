const DIFF_THRESHOLD = 26;
const AUDIO_THRESHOLD = 0.20;
const CONSECUTIVE_SPIKES_NEEDED = 4;
const DIFF_CHECK_INTERVAL_MS = 180;
const BASE_COOLDOWN = 35000;
const MAX_QUEUE_LENGTH = 5;
const NETWORK_TIMEOUT_MS = 12000;
const VISUAL_SMOOTHING = 0.24;
const AUDIO_SMOOTHING = 0.28;
const INTENSITY_SMOOTHING = 0.22;
let currentCooldown = BASE_COOLDOWN;
const SAMPLE_SCALE = 0.25;            
// ─────────────────────────────────────────────────────────────────────────────

let diffLoop = null;
let lastPixels = null;
let lastGeminiCallTime = 0;
let lastQueueTime = 0; 
let cooldownTimer = null;
let spikeCount = 0;
let env = null;
let analysisFrameId = null;
let lastAnalysisTick = 0;
let smoothedDiffPct = 0;
let smoothedAudioPct = 0;
let smoothedIntensityPct = 0;
let cachedVoiceId = null;
let lastStatusText = 'Initializing runtime...';
let lastStatusCaption = 'Preparing capture, classifiers, and voice playback.';
let lastStatusColor = '#00e5ff';
let currentPipelinePhase = 'Booting';
const diagnosticsState = {
    mode: 'live',
    scenario: 'stable',
    latencyMs: 0,
    runs: [],
};

// --- Queue & Audio State ---
let hypeQueue = [];
let isProcessingQueue = false;
let audioContext = null;
let analyser = null;
let dataArray = null;
let lastAudioPeak = 0;
let captureStream = null;
let activeAudio = null;
const HYPE_BOT_SIGNATURE = 'Hype Bot inbound.';
const sessionStats = {
    eventsSeen: 0,
    hypeCalls: 0,
    latencySamples: [],
    startedAt: new Date().toISOString(),
};
const sessionEvidence = [];
let selectedPersonaKey = 'play-by-play';
const MAX_RUNTIME_EVENTS = 120;
const runtimeState = {
    activeFilter: 'all',
    events: [],
};
const RUNTIME_FILTER_LABELS = {
    all: 'All activity',
    pipeline: 'Pipeline',
    hype: 'Hype + Voice',
    attention: 'Attention',
};
const RUNTIME_FILTERS = {
    all: () => true,
    pipeline: (event) => ['system', 'capture', 'queue', 'network'].includes(event.group),
    hype: (event) => ['hype', 'audio'].includes(event.group),
    attention: (event) => event.level === 'warn' || event.level === 'error',
};
const FEEDBACK_STORAGE_KEY = 'hype-man.feedback.v1';
const MEMORY_STORAGE_KEY = 'hype-man.memories.v1';
const MAX_FEEDBACK_ENTRIES = 60;
const MAX_MEMORY_ENTRIES = 12;
const companionState = {
    feedbackEntries: [],
    memories: [],
    lastReaction: null,
};
const performanceState = {
    classifyLatencies: [],
    voiceLatencies: [],
};
let activeMomentCandidate = null;

// ─── UI HELPERS ──────────────────────────────────────────────────────────────
function setText(id, text) {
    const el = document.getElementById(id);
    if (el) el.textContent = text;
}

function inferRuntimeGroup(stage, level) {
    if (level === 'warn' || level === 'error') return 'attention';

    const normalizedStage = String(stage || '').toLowerCase();
    if (normalizedStage.includes('audio') || normalizedStage.includes('voice')) return 'audio';
    if (normalizedStage.includes('hype') || normalizedStage.includes('reaction')) return 'hype';
    if (normalizedStage.includes('queue')) return 'queue';
    if (normalizedStage.includes('capture') || normalizedStage.includes('source')) return 'capture';
    if (normalizedStage.includes('network') || normalizedStage.includes('api') || normalizedStage.includes('diagnostic')) return 'network';
    return 'system';
}

function formatRuntimeTime(date) {
    return date.toLocaleTimeString([], {
        hour: 'numeric',
        minute: '2-digit',
        second: '2-digit',
    });
}

function formatEventCount(count) {
    return `${count} event${count === 1 ? '' : 's'}`;
}

function getFilteredRuntimeEvents() {
    const matcher = RUNTIME_FILTERS[runtimeState.activeFilter] || RUNTIME_FILTERS.all;
    return runtimeState.events.filter(matcher);
}

function buildRuntimeEventElement(event) {
    const article = document.createElement('article');
    article.className = `runtime-event ${event.level}`;

    const meta = document.createElement('div');
    meta.className = 'runtime-event-meta';

    const tags = document.createElement('div');
    tags.className = 'runtime-event-tags';

    const stageChip = document.createElement('span');
    stageChip.className = 'runtime-chip';
    stageChip.textContent = event.stage;
    tags.appendChild(stageChip);

    const levelChip = document.createElement('span');
    levelChip.className = `runtime-chip level-${event.level}`;
    levelChip.textContent = event.level;
    tags.appendChild(levelChip);

    meta.appendChild(tags);

    const time = document.createElement('div');
    time.className = 'runtime-time';
    time.textContent = event.timeLabel;
    meta.appendChild(time);

    article.appendChild(meta);

    const title = document.createElement('div');
    title.className = 'runtime-event-title';
    title.textContent = event.title;
    article.appendChild(title);

    if (event.detail) {
        const detail = document.createElement('div');
        detail.className = 'runtime-event-detail';
        detail.textContent = event.detail;
        article.appendChild(detail);
    }

    if (event.metrics.length > 0) {
        const metrics = document.createElement('div');
        metrics.className = 'runtime-metrics';
        event.metrics.forEach((metric) => {
            const pill = document.createElement('span');
            pill.className = 'runtime-metric';
            pill.textContent = metric;
            metrics.appendChild(pill);
        });
        article.appendChild(metrics);
    }

    return article;
}

function updateRuntimePanels() {
    const allEvents = runtimeState.events;
    const filteredEvents = getFilteredRuntimeEvents();
    const latestEvent = allEvents.length > 0 ? allEvents[allEvents.length - 1] : null;
    const latestHighlight = [...allEvents].reverse().find((event) => event.level === 'success');
    const latestAttention = [...allEvents].reverse().find((event) => event.level === 'warn' || event.level === 'error');
    const attentionCount = allEvents.filter((event) => event.level === 'warn' || event.level === 'error').length;
    const activeFilterLabel = RUNTIME_FILTER_LABELS[runtimeState.activeFilter] || RUNTIME_FILTER_LABELS.all;

    setText('runtime-summary-phase', currentPipelinePhase);
    setText('runtime-summary-phase-sub', lastStatusCaption || 'Preparing the live capture and reaction stack.');
    setText('runtime-summary-highlight', latestHighlight ? latestHighlight.title : 'No hype yet');
    setText(
        'runtime-summary-highlight-sub',
        latestHighlight
            ? (latestHighlight.detail || `${latestHighlight.stage} update at ${latestHighlight.timeLabel}.`)
            : 'Approved reactions and big queue milestones appear here.'
    );
    setText('runtime-summary-attention', String(attentionCount));
    setText(
        'runtime-summary-attention-sub',
        latestAttention
            ? `${latestAttention.stage} at ${latestAttention.timeLabel}: ${latestAttention.title}`
            : 'Warnings and errors are counted so blockers are easy to spot.'
    );
    setText('runtime-summary-coverage', formatEventCount(filteredEvents.length));
    setText(
        'runtime-summary-coverage-sub',
        runtimeState.events.length === 0
            ? 'Showing the current filtered activity stream.'
            : `Filter: ${activeFilterLabel} of ${formatEventCount(runtimeState.events.length)} total.`
    );

    setText('readout-headline', latestEvent ? latestEvent.title : 'Runtime waking up');
    setText(
        'readout-detail',
        latestEvent
            ? (latestEvent.detail || `${latestEvent.stage} update at ${latestEvent.timeLabel}.`)
            : 'The latest capture, queue, reaction, and failure notes will surface here while the full timeline lives in the Runtime Hype tab.'
    );
    setText('readout-time', latestEvent ? latestEvent.timeLabel : 'Just now');
    setText('runtime-filter-label', activeFilterLabel);

    const caption = runtimeState.events.length === 0
        ? 'Runtime activity will appear once the app starts moving through capture and classification.'
        : `Showing ${formatEventCount(filteredEvents.length)} from ${formatEventCount(runtimeState.events.length)} with newest events first.`;
    setText('runtime-caption', caption);
}

function renderRuntimeFeed() {
    const feed = document.getElementById('runtime-feed');
    const filteredEvents = getFilteredRuntimeEvents();
    updateRuntimePanels();

    if (!feed) return;

    feed.innerHTML = '';
    if (filteredEvents.length === 0) {
        const empty = document.createElement('div');
        empty.className = 'runtime-empty';
        empty.textContent = runtimeState.events.length === 0
            ? 'Runtime activity will appear once the app starts moving through capture and classification.'
            : `No events match the ${RUNTIME_FILTER_LABELS[runtimeState.activeFilter] || 'selected'} filter yet.`;
        feed.appendChild(empty);
        return;
    }

    filteredEvents.slice().reverse().forEach((event) => {
        feed.appendChild(buildRuntimeEventElement(event));
    });
}

function setRuntimeFilter(filter) {
    if (!RUNTIME_FILTERS[filter]) return;
    runtimeState.activeFilter = filter;
    document.querySelectorAll('[data-runtime-filter]').forEach((button) => {
        button.classList.toggle('active', button.dataset.runtimeFilter === filter);
    });
    renderRuntimeFeed();
}

function setOperationsTab(tab) {
    document.querySelectorAll('[data-ops-tab]').forEach((button) => {
        const isActive = button.dataset.opsTab === tab;
        button.classList.toggle('active', isActive);
        button.setAttribute('aria-selected', isActive ? 'true' : 'false');
    });

    document.querySelectorAll('.tab-panel').forEach((panel) => {
        const isActive = panel.id === `panel-${tab}`;
        panel.classList.toggle('active', isActive);
        panel.hidden = !isActive;
    });
}

function log(entry, options = {}) {
    const payload = typeof entry === 'string' ? { title: entry } : (entry || {});
    const now = new Date();
    const event = {
        id: `${now.getTime()}-${Math.random().toString(16).slice(2, 8)}`,
        stage: payload.stage || options.stage || 'Runtime',
        level: payload.level || options.level || 'info',
        group: payload.group || options.group || inferRuntimeGroup(payload.stage || options.stage, payload.level || options.level || 'info'),
        title: payload.title || payload.message || 'Runtime update',
        detail: payload.detail || options.detail || '',
        metrics: Array.isArray(payload.metrics) ? payload.metrics.filter(Boolean) : [],
        timeLabel: formatRuntimeTime(now),
    };

    runtimeState.events.push(event);
    if (runtimeState.events.length > MAX_RUNTIME_EVENTS) {
        runtimeState.events.shift();
    }

    renderRuntimeFeed();
}

function readStoredJson(key, fallback) {
    try {
        const raw = window.localStorage.getItem(key);
        return raw ? JSON.parse(raw) : fallback;
    } catch (error) {
        return fallback;
    }
}

function writeStoredJson(key, value) {
    try {
        window.localStorage.setItem(key, JSON.stringify(value));
    } catch (error) {
        // Ignore storage failures in desktop preview mode.
    }
}

function getFeedbackProfile() {
    return window.HypeCore.buildFeedbackProfile(companionState.feedbackEntries);
}

function persistCompanionState() {
    writeStoredJson(FEEDBACK_STORAGE_KEY, companionState.feedbackEntries.slice(0, MAX_FEEDBACK_ENTRIES));
    writeStoredJson(MEMORY_STORAGE_KEY, companionState.memories.slice(0, MAX_MEMORY_ENTRIES));
}

function renderMemoryPanel() {
    const memoryList = document.getElementById('memory-list');
    const memoryEmpty = document.getElementById('memory-empty');
    const headline = document.getElementById('memory-headline');
    const copy = document.getElementById('memory-copy');

    if (!memoryList || !memoryEmpty || !headline || !copy) return;

    memoryList.innerHTML = '';
    const previewMemories = [...companionState.memories]
        .sort((left, right) => {
            const leftScore = (left.feedbackLabel === 'nailed-it' ? 2 : 0) + (left.playCount || 0);
            const rightScore = (right.feedbackLabel === 'nailed-it' ? 2 : 0) + (right.playCount || 0);
            return rightScore - leftScore;
        })
        .slice(0, 3);

    if (previewMemories.length === 0) {
        headline.textContent = 'No callbacks yet';
        copy.textContent = 'Big moments that genuinely land can be remembered and fed back into later reactions.';
        memoryEmpty.hidden = false;
        return;
    }

    headline.textContent = `${companionState.memories.length} learned moment${companionState.memories.length === 1 ? '' : 's'}`;
    copy.textContent = 'These are the moments most worth calling back to when the player starts cooking again.';
    memoryEmpty.hidden = true;

    previewMemories.forEach((memory) => {
        const item = document.createElement('div');
        item.className = 'memory-item';
        item.innerHTML = `
            <div class="memory-item-title">${memory.situation}</div>
            <div class="memory-item-sub">${memory.reaction} • ${memory.category || 'General'} • ${memory.feedbackLabel === 'nailed-it' ? 'validated' : 'observed'}</div>
        `;
        memoryList.appendChild(item);
    });
}

function syncFeedbackButtons() {
    const activeLabel = companionState.lastReaction?.feedbackLabel || '';
    const hasReaction = Boolean(companionState.lastReaction);

    document.querySelectorAll('[data-feedback-label]').forEach((button) => {
        button.classList.toggle('active', hasReaction && button.dataset.feedbackLabel === activeLabel);
        button.disabled = !hasReaction;
    });
}

function syncFeedbackPanel() {
    const headline = document.getElementById('feedback-headline');
    const copy = document.getElementById('feedback-copy');
    const summary = document.getElementById('feedback-summary');
    const profile = getFeedbackProfile();

    if (!headline || !copy || !summary) return;

    if (!companionState.lastReaction) {
        headline.textContent = 'No reaction to rate yet';
        copy.textContent = 'When a line lands or misses, score it here so the companion learns how much presence and restraint feels right.';
    } else {
        headline.textContent = companionState.lastReaction.reaction || companionState.lastReaction.situation;
        copy.textContent = `${companionState.lastReaction.situation} • ${companionState.lastReaction.persona || 'Witness'} • ${companionState.lastReaction.category || 'General'}`;
    }

    if (profile.total === 0) {
        summary.textContent = 'Taste profile is still blank.';
    } else {
        summary.textContent = `${profile.nailedIt} nailed • ${profile.tooMuch} too much • ${profile.missedIt} missed. Current bias: ${profile.restraintBias}.`;
    }

    syncFeedbackButtons();
}

function syncCompanionPanels() {
    syncFeedbackPanel();
    renderMemoryPanel();
}

function loadCompanionState() {
    const feedbackEntries = readStoredJson(FEEDBACK_STORAGE_KEY, []);
    const memories = readStoredJson(MEMORY_STORAGE_KEY, []);
    companionState.feedbackEntries = Array.isArray(feedbackEntries) ? feedbackEntries.slice(0, MAX_FEEDBACK_ENTRIES) : [];
    companionState.memories = Array.isArray(memories) ? memories.slice(0, MAX_MEMORY_ENTRIES) : [];
    syncCompanionPanels();
}

function rememberMoment(entry) {
    if (!entry || !entry.situation || !entry.reaction) return null;

    const memory = {
        id: entry.id || `memory-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`,
        capturedAt: entry.capturedAt || new Date().toISOString(),
        situation: entry.situation,
        category: entry.category || 'General',
        reaction: entry.reaction,
        source: entry.source || 'auto',
        persona: entry.persona || '',
        intensityPct: Math.round(entry.intensityPct || entry.diffPct || 0),
        feedbackLabel: entry.feedbackLabel || null,
        playCount: entry.playCount || 1,
    };

    const existingIndex = companionState.memories.findIndex((item) => item.situation === memory.situation && item.reaction === memory.reaction);
    if (existingIndex >= 0) {
        const existing = companionState.memories[existingIndex];
        companionState.memories.splice(existingIndex, 1);
        companionState.memories.unshift({
            ...existing,
            ...memory,
            playCount: Math.max(existing.playCount || 1, memory.playCount || 1),
            feedbackLabel: memory.feedbackLabel || existing.feedbackLabel || null,
        });
    } else {
        companionState.memories.unshift(memory);
    }

    companionState.memories = companionState.memories.slice(0, MAX_MEMORY_ENTRIES);
    persistCompanionState();
    syncCompanionPanels();
    return companionState.memories[0];
}

function setLatestReactionContext(reactionContext) {
    companionState.lastReaction = reactionContext ? { ...reactionContext } : null;
    syncCompanionPanels();
}

function recordReactionFeedback(label) {
    if (!companionState.lastReaction) return;

    const feedbackEntry = {
        id: `feedback-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`,
        reactionId: companionState.lastReaction.id,
        label,
        situation: companionState.lastReaction.situation,
        reaction: companionState.lastReaction.reaction,
        category: companionState.lastReaction.category,
        createdAt: new Date().toISOString(),
    };

    const existingIndex = companionState.feedbackEntries.findIndex((entry) => entry.reactionId === companionState.lastReaction.id);
    if (existingIndex >= 0) {
        companionState.feedbackEntries.splice(existingIndex, 1, feedbackEntry);
    } else {
        companionState.feedbackEntries.unshift(feedbackEntry);
    }
    companionState.feedbackEntries = companionState.feedbackEntries.slice(0, MAX_FEEDBACK_ENTRIES);

    if (companionState.lastReaction.memoryId) {
        const memoryIndex = companionState.memories.findIndex((memory) => memory.id === companionState.lastReaction.memoryId);
        if (memoryIndex >= 0) {
            const currentMemory = companionState.memories[memoryIndex];
            companionState.memories.splice(memoryIndex, 1, {
                ...currentMemory,
                feedbackLabel: label,
                playCount: label === 'nailed-it' ? (currentMemory.playCount || 1) + 1 : (currentMemory.playCount || 1),
            });
        }
    }

    companionState.lastReaction = {
        ...companionState.lastReaction,
        feedbackLabel: label,
    };
    persistCompanionState();
    syncCompanionPanels();
    log({
        stage: 'Learning',
        level: label === 'nailed-it' ? 'success' : label === 'too-much' ? 'warn' : 'info',
        title: 'Feedback captured',
        detail: `Stored "${label}" for the latest companion line.`,
    });
}

async function primeVoiceChoice() {
    if (cachedVoiceId || !env?.ELEVENLABS_API_KEY || diagnosticsState.mode === 'mock') {
        return cachedVoiceId;
    }

    const voicesRes = await fetchWithTimeout('https://api.elevenlabs.io/v1/voices', {
        headers: { 'xi-api-key': env.ELEVENLABS_API_KEY },
    });
    if (!voicesRes.ok) return cachedVoiceId;

    const voiceData = await voicesRes.json();
    const brandedVoice = voiceData.voices?.find((voice) => {
        const name = (voice.name || '').toLowerCase();
        return name.includes('adam') || name.includes('anton') || name.includes('arnold');
    });
    cachedVoiceId = brandedVoice?.voice_id || voiceData.voices?.[0]?.voice_id || cachedVoiceId;
    return cachedVoiceId;
}

function getPersonaByKey(key) {
    return window.HypeCore.getPersonaByKey(key);
}

function choosePersonaForItem(item) {
    return window.HypeCore.choosePersona(item, selectedPersonaKey);
}

function getPersonaStatusLabel() {
    return selectedPersonaKey === 'auto' ? 'Auto Rotate' : getPersonaByKey(selectedPersonaKey).label;
}

function setStatus(msg, color = '#00e5ff') {
    const el = document.getElementById('status-bar');
    if (el && msg !== lastStatusText) {
        el.textContent = msg;
        lastStatusText = msg;
    }
    if (el && color !== lastStatusColor) {
        el.style.borderLeftColor = color;
        el.style.color = color;
        lastStatusColor = color;
    }
}

function setStatusCaption(text) {
    const el = document.getElementById('status-caption');
    if (el && text !== lastStatusCaption) {
        el.textContent = text;
        lastStatusCaption = text;
    }
    updateRuntimePanels();
}

function updatePersonaBadge() {
    const el = document.getElementById('persona-badge');
    if (el) el.textContent = getPersonaStatusLabel();
}

function updateQueueDepth() {
    const el = document.getElementById('queue-depth');
    if (el) el.textContent = String(hypeQueue.length);
    updateRuntimePanels();
}

function setPipelinePhase(phase, detail = '', color = '#8ea2c2') {
    currentPipelinePhase = phase;
    const phaseEl = document.getElementById('pipeline-phase');
    if (phaseEl) phaseEl.textContent = phase;
    setStatus(phase, color);
    if (detail) setStatusCaption(detail);
    updateRuntimePanels();
}

function updateSourceBadge(text) {
    const el = document.getElementById('source-badge');
    if (el) el.textContent = text;
}

function updateSignalBlend(value) {
    const el = document.getElementById('signal-blend');
    if (el) el.textContent = `${Math.round(value)}%`;
}

function setConfidenceBadge(text) {
    const el = document.getElementById('confidence-badge');
    if (el) el.textContent = text;
}

function updateDiagnosticsHealth(status, summary) {
    const healthEl = document.getElementById('diagnostics-health');
    const summaryEl = document.getElementById('diagnostics-summary');
    if (healthEl) healthEl.textContent = status;
    if (summaryEl) summaryEl.textContent = summary;
}

function renderDiagnosticsResults() {
    const tbody = document.getElementById('diagnostics-results-body');
    if (!tbody) return;

    tbody.innerHTML = '';
    if (diagnosticsState.runs.length === 0) {
        tbody.innerHTML = '<tr id="diagnostics-results-empty"><td colspan="5" style="color:#8ea2c2; font-style:italic;">No diagnostics results yet.</td></tr>';
        return;
    }

    diagnosticsState.runs.slice().reverse().forEach((run) => {
        const tr = document.createElement('tr');
        const statusClass = run.passed ? 'diag-pass' : 'diag-fail';
        tr.innerHTML = `
            <td>${run.scenario}</td>
            <td class="${statusClass}">${run.passed ? 'PASS' : 'FAIL'}</td>
            <td>${run.latencyMs}ms</td>
            <td>${run.durationMs}ms</td>
            <td>${run.detail}</td>
        `;
        tbody.appendChild(tr);
    });
}

function wait(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

function getDiagnosticsConfig() {
    return {
        mode: diagnosticsState.mode,
        scenario: diagnosticsState.scenario,
        latencyMs: diagnosticsState.latencyMs,
    };
}

async function mockGeminiResponse(item, persona) {
    const { scenario, latencyMs } = getDiagnosticsConfig();
    if (latencyMs > 0) await wait(latencyMs);

    if (scenario === 'rate-limit') {
        return { status: 429, payload: null };
    }
    if (scenario === 'empty-model') {
        return { status: 200, payload: { candidates: [] } };
    }
    if (scenario === 'malformed-json') {
        return {
            status: 200,
            payload: {
                candidates: [{ content: { parts: [{ text: 'not valid json' }] } }],
            },
        };
    }

    const reaction = item.diffPct >= 55
        ? `${persona.label} says this is elite.`
        : 'That was clean work.';

    return {
        status: 200,
        payload: {
            candidates: [{
                content: {
                    parts: [{
                        text: JSON.stringify({
                            isHypeWorthy: scenario !== 'stable' || item.diffPct >= 10,
                            situation: item.source === 'manual' ? 'Manual showcase moment' : 'Live detected moment',
                            category: item.diffPct >= 55 ? 'Gaming' : 'General',
                            reaction,
                        }),
                    }],
                },
            }],
        },
    };
}

async function requestGeminiAnalysis(item, systemPrompt, persona) {
    if (diagnosticsState.mode === 'mock') {
        return mockGeminiResponse(item, persona);
    }

    const res = await fetchWithTimeout(`https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${env.GEMINI_API_KEY}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            contents: [{ parts: [
                { text: systemPrompt },
                { inlineData: { mimeType: 'image/jpeg', data: item.base64Data } }
            ]}],
            generationConfig: { responseMimeType: 'application/json' }
        })
    });

    return {
        status: res.status,
        headers: {
            limit: res.headers.get('x-ratelimit-limit'),
            remaining: res.headers.get('x-ratelimit-remaining'),
        },
        payload: await res.json(),
    };
}

async function requestVoicePlayback(text) {
    if (diagnosticsState.mode === 'mock') {
        if (diagnosticsState.latencyMs > 0) await wait(diagnosticsState.latencyMs);
        if (diagnosticsState.scenario === 'audio-failure') {
            throw new Error('Injected audio failure.');
        }
        return { audioUrl: null, mock: true };
    }

    let voiceId = cachedVoiceId || 'pNInz6obbfDQGcgMyIGD';
    const primedVoiceId = await primeVoiceChoice();
    if (primedVoiceId) {
        voiceId = primedVoiceId;
    }

    const spokenText = `${HYPE_BOT_SIGNATURE} ${text}`;
    const ttsRes = await fetchWithTimeout(
        `https://api.elevenlabs.io/v1/text-to-speech/${voiceId}?model_id=eleven_turbo_v2_5`,
        {
            method: 'POST',
            headers: { 'Accept': 'audio/mpeg', 'xi-api-key': env.ELEVENLABS_API_KEY, 'Content-Type': 'application/json' },
            body: JSON.stringify({
                text: spokenText,
                voice_settings: {
                    stability: 0.22,
                    similarity_boost: 0.9,
                    style: 0.7,
                    use_speaker_boost: true
                }
            })
        }
    );

    if (!ttsRes.ok) throw new Error('ElevenLabs: ' + await ttsRes.text());
    return { audioUrl: URL.createObjectURL(await ttsRes.blob()), mock: false };
}

function fetchWithTimeout(url, options = {}, timeoutMs = NETWORK_TIMEOUT_MS) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    return fetch(url, { ...options, signal: controller.signal })
        .finally(() => clearTimeout(timeout));
}

function getMedianLatency() {
    if (sessionStats.latencySamples.length === 0) return 0;
    const sorted = [...sessionStats.latencySamples].sort((a, b) => a - b);
    const mid = Math.floor(sorted.length / 2);
    if (sorted.length % 2 === 0) {
        return Math.round((sorted[mid - 1] + sorted[mid]) / 2);
    }
    return sorted[mid];
}

function updateStatsUI() {
    const eventsEl = document.getElementById('stat-events');
    const callsEl = document.getElementById('stat-hype-calls');
    const hitRateEl = document.getElementById('stat-hit-rate');
    const latencyEl = document.getElementById('stat-latency');
    if (!eventsEl || !callsEl || !hitRateEl || !latencyEl) return;

    const hitRate = sessionStats.eventsSeen === 0
        ? 0
        : Math.round((sessionStats.hypeCalls / sessionStats.eventsSeen) * 100);

    eventsEl.textContent = String(sessionStats.eventsSeen);
    callsEl.textContent = String(sessionStats.hypeCalls);
    hitRateEl.textContent = `${hitRate}%`;
    latencyEl.textContent = `${getMedianLatency()}ms`;
    updatePersonaBadge();
    updateQueueDepth();
}

function recordEvidence(entry) {
    sessionEvidence.push({
        ...entry,
        capturedAt: new Date().toISOString(),
    });
}

function setDiffMeter(pct) {
    const bar = document.getElementById('diff-bar');
    const label = document.getElementById('diff-label');
    if (!bar || !label) return;
    const clamped = window.HypeCore.clamp(pct, 0, 100);
    bar.style.width = clamped + '%';
    bar.style.background = clamped > 60 ? '#f44336' : clamped > 25 ? '#ff9800' : '#00bcd4';
    label.textContent = Math.round(clamped) + '%';
}

function setAudioMeter(pct) {
    const bar = document.getElementById('audio-bar');
    const label = document.getElementById('audio-label');
    if (!bar || !label) return;
    const clamped = window.HypeCore.clamp(pct, 0, 100);
    bar.style.width = clamped + '%';
    bar.style.background = clamped > (AUDIO_THRESHOLD * 100) ? '#ff6b8a' : '#53f1cf';
    label.textContent = `${Math.round(clamped)}%`;
}

function setIntensityMeter(pct) {
    const bar = document.getElementById('intensity-bar');
    const label = document.getElementById('intensity-label');
    if (!bar || !label) return;
    const clamped = window.HypeCore.clamp(pct, 0, 100);
    bar.style.width = clamped + '%';
    label.textContent = `${Math.round(clamped)}%`;
    updateSignalBlend(clamped);
}

function startCooldownDisplay(ms) {
    if (cooldownTimer) clearInterval(cooldownTimer);
    let remaining = Math.round(ms / 1000);
    const qLen = hypeQueue.length;
    const qText = qLen > 0 ? ` (${qLen} in queue)` : '';
    
    currentPipelinePhase = 'Cooldown';
    setStatus(`Cooldown${qText} - next in ${remaining}s`, '#7986cb');
    setStatusCaption('Adaptive backoff is protecting the app from API rate spikes.');
    updateRuntimePanels();
    cooldownTimer = setInterval(() => {
        remaining--;
        const curQLen = hypeQueue.length;
        const curQText = curQLen > 0 ? ` (${curQLen} in queue)` : '';
        
        if (remaining <= 0) {
            clearInterval(cooldownTimer);
            setStatus(curQLen > 0 ? `Processing queue...${curQText}` : 'Watching for action...', curQLen > 0 ? '#ffeb3b' : '#00e5ff');
            setStatusCaption(curQLen > 0
                ? 'Queued moments are resuming after cooldown.'
                : 'Live capture is active and waiting for a meaningful moment.');
        } else {
            setStatus(`Cooldown${curQText} - next in ${remaining}s`, '#7986cb');
        }
    }, 1000);
}

// ─── LOG SHEET ───────────────────────────────────────────────────────────────
function addLogEntry(situation, category, reaction, diffPct, audioPeak = 0, personaLabel = '') {
    const tbody = document.getElementById('log-body');
    if (!tbody) return;

    const placeholder = document.getElementById('log-empty');
    if (placeholder) placeholder.remove();

    const normalizedReaction = typeof reaction === 'string' ? reaction.trim() : '';
    const isHyped = Boolean(normalizedReaction && normalizedReaction !== '-');
    const now = new Date().toLocaleTimeString();

    const CATEGORY_COLORS = {
        'Gaming': '#e91e63', 'Coding': '#00bcd4', 'Browsing': '#8bc34a',
        'Social': '#ff9800', 'Creative': '#9c27b0', 'Productivity': '#3f51b5',
        'Work': '#607d8b', 'AI Tools': '#f44336', 'General': '#78909c', 'Idle': '#424242',
    };
    const color = CATEGORY_COLORS[category] || '#78909c';

    const tr = document.createElement('tr');
    tr.style.borderBottom = '1px solid #2a2a2a';
    tr.innerHTML = `
        <td style="padding:6px 8px; color:#888; white-space:nowrap; font-size:12px;">${now}</td>
        <td style="padding:6px 8px; font-size:13px;">${situation}</td>
        <td style="padding:6px 8px;">
            <span style="background:${color}22; color:${color}; border:1px solid ${color}55;
                         padding:2px 8px; border-radius:12px; font-size:11px; font-weight:bold;">
                ${category}
            </span>
        </td>
        <td style="padding:6px 8px; font-size:13px; font-weight:bold; color:${isHyped ? '#ff9800' : '#555'};">
            ${normalizedReaction || '-'}
            ${personaLabel ? `<div style="margin-top:4px; font-size:10px; letter-spacing:0.6px; text-transform:uppercase; color:#777;">${personaLabel}</div>` : ''}
        </td>
        <td style="padding:6px 8px; text-align:center; font-size:12px; color:#666;">
            Vis: ${Math.round(diffPct)}%<br/>Aud: ${Math.round(audioPeak * 100)}%
        </td>
        <td style="padding:6px 8px; text-align:center;">${isHyped ? 'Yes' : 'No'}</td>
    `;
    tbody.insertBefore(tr, tbody.firstChild);
}

// ─── FRAME DIFF ENGINE ────────────────────────────────────────────────────────
function computeFrameDiff(ctx, canvas, video) {
    const w = Math.floor(video.videoWidth * SAMPLE_SCALE);
    const h = Math.floor(video.videoHeight * SAMPLE_SCALE);
    if (w === 0 || h === 0) return 0;

    canvas.width = w;
    canvas.height = h;
    ctx.drawImage(video, 0, 0, w, h);

    const frame = ctx.getImageData(0, 0, w, h).data; // RGBA flat array

    if (!lastPixels || lastPixels.length !== frame.length) {
        lastPixels = new Uint8ClampedArray(frame);
        return 0;
    }

    let totalDiff = 0;
    const pixelCount = frame.length / 4;
    for (let i = 0; i < frame.length; i += 4) {
        const dr = Math.abs(frame[i]     - lastPixels[i]);
        const dg = Math.abs(frame[i + 1] - lastPixels[i + 1]);
        const db = Math.abs(frame[i + 2] - lastPixels[i + 2]);
        totalDiff += (dr + dg + db) / 3;
    }

    lastPixels = new Uint8ClampedArray(frame);
    return totalDiff / pixelCount; // avg diff per pixel, 0-255
}

// --- Hype Queue & Worker ---
function addToHypeQueue(diffPct, audioPeak, options = {}) {
    const now = options.timestamp || Date.now();
    const intensityPct = Math.round(options.intensityPct || window.HypeCore.computeIntensity(diffPct, audioPeak * 100));
    const source = options.source || 'auto';
    
    // Deduplication: If we just queued a hype < 2 seconds ago, skip this one.
    // This prevents a 3-second goal roar from queuing 15 separate frames.
    if (now - lastQueueTime < 2000) {
        return; 
    }
    lastQueueTime = now;

    log({
        stage: 'Queue',
        level: 'info',
        title: 'Moment captured',
        detail: source === 'manual'
            ? 'A manual showcase moment is moving into the review queue.'
            : 'A live candidate is moving into the review queue.',
        metrics: [`Visual ${Math.round(diffPct)}%`, `Audio ${Math.round(audioPeak * 100)}%`, `Intensity ${intensityPct}%`],
    });
    
    const fullCanvas = document.getElementById('full-canvas');
    const fullCtx = fullCanvas.getContext('2d', { willReadFrequently: true });
    const video = document.getElementById('video-feed');
    fullCanvas.width = video.videoWidth;
    fullCanvas.height = video.videoHeight;
    fullCtx.drawImage(video, 0, 0);
    const base64Data = fullCanvas.toDataURL('image/jpeg', 0.85).split(',')[1];

    sessionStats.eventsSeen++;
    updateStatsUI();

    hypeQueue.push({ base64Data, diffPct, audioPeak, intensityPct, timestamp: now, retryCount: 0, source });

    if (hypeQueue.length > MAX_QUEUE_LENGTH) hypeQueue.shift();
    updateQueueDepth();
    setPipelinePhase('Queued', 'A candidate moment is waiting for classification.', '#ffbf69');

    if (!isProcessingQueue) processQueue();
}

function queueManualHype() {
    const video = document.getElementById('video-feed');
    if (!video || video.videoWidth === 0) {
        log({
            stage: 'Queue',
            level: 'warn',
            title: 'Manual trigger ignored',
            detail: 'Pick a live source before forcing a showcase reaction.',
        });
        return;
    }

    const now = Date.now();
    const fullCanvas = document.getElementById('full-canvas');
    const fullCtx = fullCanvas.getContext('2d', { willReadFrequently: true });
    fullCanvas.width = video.videoWidth;
    fullCanvas.height = video.videoHeight;
    fullCtx.drawImage(video, 0, 0);

    sessionStats.eventsSeen++;
    updateStatsUI();

    addToHypeQueue(100, lastAudioPeak, {
        source: 'manual',
        intensityPct: 100,
        timestamp: now,
    });
    setPipelinePhase('Queued', 'Manual showcase moment added to the live queue.', '#ffbf69');
    if (!isProcessingQueue) processQueue();
}

async function processQueue() {
    if (isProcessingQueue || hypeQueue.length === 0) return;
    isProcessingQueue = true;
    updateQueueDepth();

    while (hypeQueue.length > 0) {
        const now = Date.now();
        const timeSinceLast = now - lastGeminiCallTime;
        
        if (timeSinceLast < currentCooldown) {
            const waitMs = currentCooldown - timeSinceLast;
            startCooldownDisplay(waitMs);
            await new Promise(r => setTimeout(r, waitMs));
        }

        const item = hypeQueue.shift();
        updateQueueDepth();
        setPipelinePhase('Classifying', 'Running multimodal classification and reaction generation.', '#62d7ff');
        log({
            stage: 'Queue',
            level: 'info',
            title: 'Reviewing queued moment',
            detail: 'Sending the next captured moment through the classifier.',
            metrics: [`Remaining ${hypeQueue.length}`],
        });
        const success = await callGemini(item);
        
        if (!success) {
            // BACK OFF: Increase cooldown by 15s if we hit an error/429
            currentCooldown = window.HypeCore.nextCooldown(currentCooldown, {
                success: false,
                baseCooldown: BASE_COOLDOWN,
                maxCooldown: 90000,
            });
            log({
                stage: 'Network',
                level: 'warn',
                title: 'Cooldown increased',
                detail: 'Adaptive backoff stretched the retry window after a failed classification call.',
                metrics: [`Next retry ${currentCooldown / 1000}s`],
            });
            
            // Put item back
            item.retryCount = (item.retryCount || 0) + 1;
            if (item.retryCount <= 1) {
                hypeQueue.unshift(item);
                updateQueueDepth();
            }
        } else {
            // SUCCESS: Slowly decay the backoff back to base
            currentCooldown = window.HypeCore.nextCooldown(currentCooldown, {
                success: true,
                baseCooldown: BASE_COOLDOWN,
                maxCooldown: 90000,
            });
        }
    }

    isProcessingQueue = false;
    setPipelinePhase('Watching', 'Live capture is active and waiting for a meaningful moment.', '#00e5ff');
}

async function callGemini(item) {
    if (!env?.GEMINI_API_KEY) return false;
    setPipelinePhase('Analyzing', 'Interpreting the live frame and checking whether the moment deserves a reaction.', '#ffeb3b');

    const persona = choosePersonaForItem(item);
    const recentHypes = window._recentHypes || [];
    const systemPrompt = window.HypeCore.buildSystemPrompt(item, persona, recentHypes);

    try {
        const response = await requestGeminiAnalysis(item, systemPrompt, persona);
        const res = response;

        const limit = response.headers?.limit;
        const remaining = response.headers?.remaining;
        log(`📡 API Status: ${res.status} | Rem: ${remaining || '?'}/${limit || '?'}`);

        if (response.status === 429) {
            log('⚠️ 429 Hit! Triggering global backoff.');
            lastGeminiCallTime = Date.now();
            return false;
        }
        if (response.status === 503) {
            log('Gemini service is temporarily unavailable. Retrying with backoff.');
            lastGeminiCallTime = Date.now();
            return false;
        }
        if (response.status < 200 || response.status >= 300) throw new Error(`HTTP ${response.status}`);

        const data = response.payload;
        if (!data.candidates?.[0]) {
            log('Model returned no content.');
            return true; 
        }

        const rawText = data.candidates[0].content.parts[0].text || '';
        const parsed = window.HypeCore.safeParseModelResponse(rawText);
        if (!parsed.ok) throw new Error(parsed.error);
        const hypeData = parsed.data;
        lastGeminiCallTime = Date.now();
        const latencyMs = Date.now() - item.timestamp;
        sessionStats.latencySamples.push(latencyMs);

        if (hypeData.isHypeWorthy && hypeData.reaction) {
            log(`Reaction accepted: ${hypeData.reaction}`);
            setStatus(`"${hypeData.reaction}"`, '#ff9800');
            if (!window._recentHypes) window._recentHypes = [];
            window._recentHypes.push(hypeData.reaction);
            if (window._recentHypes.length > 5) window._recentHypes.shift();
            sessionStats.hypeCalls++;
            updateStatsUI();
            setConfidenceBadge('Moment validated');
            recordEvidence({
                type: 'hype',
                source: item.source || 'auto',
                situation: hypeData.situation,
                category: hypeData.category,
                persona: persona.label,
                reaction: hypeData.reaction,
                diffPct: Math.round(item.diffPct),
                audioPeakPct: Math.round(item.audioPeak * 100),
                latencyMs,
            });
            addLogEntry(hypeData.situation, hypeData.category, hypeData.reaction, item.diffPct, item.audioPeak, persona.label);
            await playElevenLabsAudio(hypeData.reaction);
        } else {
            log(`Not hype: ${hypeData.situation}`);
            setConfidenceBadge('Classifier passed');
            addLogEntry(hypeData.situation, hypeData.category, '—', item.diffPct, item.audioPeak, persona.label);
        }

        return true;
    } catch (e) {
        log(`Error: ${e.message}`);
        lastGeminiCallTime = Date.now();
        return false;
    }
}

// ─── AUDIO ───────────────────────────────────────────────────────────────────
async function playElevenLabsAudio(text) {
    try {
        if (!env?.ELEVENLABS_API_KEY) {
            log('Voice synthesis skipped: missing ElevenLabs key.');
            return;
        }
        log('Synthesizing voice...');
        let voiceId = cachedVoiceId || 'pNInz6obbfDQGcgMyIGD';
        const voicesRes = await fetchWithTimeout('https://api.elevenlabs.io/v1/voices', {
            headers: { 'xi-api-key': env.ELEVENLABS_API_KEY }
        });
        if (voicesRes.ok) {
            const vData = await voicesRes.json();
            const brandedVoice = vData.voices?.find((voice) => {
                const name = (voice.name || '').toLowerCase();
                return name.includes('adam') || name.includes('anton') || name.includes('arnold');
            });
            if (brandedVoice?.voice_id) {
                voiceId = brandedVoice.voice_id;
            } else if (vData.voices?.length > 0) {
                voiceId = vData.voices[0].voice_id;
            }
            cachedVoiceId = voiceId;
        }

        const spokenText = `${HYPE_BOT_SIGNATURE} ${text}`;

        const ttsRes = await fetchWithTimeout(
            `https://api.elevenlabs.io/v1/text-to-speech/${voiceId}?model_id=eleven_turbo_v2_5`,
            {
                method: 'POST',
                headers: { 'Accept': 'audio/mpeg', 'xi-api-key': env.ELEVENLABS_API_KEY, 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    text: spokenText,
                    voice_settings: {
                        stability: 0.22,
                        similarity_boost: 0.9,
                        style: 0.7,
                        use_speaker_boost: true
                    }
                })
            }
        );

        if (!ttsRes.ok) throw new Error('ElevenLabs: ' + await ttsRes.text());
        const audioUrl = URL.createObjectURL(await ttsRes.blob());
        if (activeAudio) {
            activeAudio.pause();
            activeAudio.src = '';
        }
        activeAudio = new Audio(audioUrl);
        activeAudio.onended = () => URL.revokeObjectURL(audioUrl);
        activeAudio.play();
        setPipelinePhase('Speaking', 'Delivering the reaction through voice playback.', '#53f1cf');
        log('Voice playback started.');
    } catch (e) {
        log(`Audio error: ${e.message}`);
    }
}

// ─── SCREEN SETUP ────────────────────────────────────────────────────────────
function cleanupRuntimeState() {
    if (analysisFrameId) {
        cancelAnimationFrame(analysisFrameId);
        analysisFrameId = null;
    }

    diffLoop = null;

    if (cooldownTimer) {
        clearInterval(cooldownTimer);
        cooldownTimer = null;
    }

    if (captureStream) {
        captureStream.getTracks().forEach((track) => track.stop());
        captureStream = null;
    }

    const video = document.getElementById('video-feed');
    if (video) {
        video.pause();
        video.srcObject = null;
    }

    if (audioContext) {
        audioContext.close().catch(() => {});
        audioContext = null;
    }

    analyser = null;
    dataArray = null;
    hypeQueue = [];
    isProcessingQueue = false;
    activeMomentCandidate = null;
    spikeCount = 0;
    lastPixels = null;
    lastAnalysisTick = 0;
    smoothedDiffPct = 0;
    smoothedAudioPct = 0;
    smoothedIntensityPct = 0;
    updateQueueDepth();
    setDiffMeter(0);
    setAudioMeter(0);
    setIntensityMeter(0);
    setConfidenceBadge('Confidence building');

    if (activeAudio) {
        activeAudio.pause();
        activeAudio.src = '';
        activeAudio = null;
    }
}

function exportSessionEvidence() {
    const diagnosticsSummary = {
        totalRuns: diagnosticsState.runs.length,
        passedRuns: diagnosticsState.runs.filter((run) => run.passed).length,
        failedRuns: diagnosticsState.runs.filter((run) => !run.passed).length,
        latestRun: diagnosticsState.runs.length > 0 ? diagnosticsState.runs[diagnosticsState.runs.length - 1] : null,
    };
    const feedbackProfile = getFeedbackProfile();
    const medianClassifyLatency = performanceState.classifyLatencies.length === 0
        ? 0
        : Math.round([...performanceState.classifyLatencies].sort((a, b) => a - b)[Math.floor(performanceState.classifyLatencies.length / 2)]);
    const medianVoiceLatency = performanceState.voiceLatencies.length === 0
        ? 0
        : Math.round([...performanceState.voiceLatencies].sort((a, b) => a - b)[Math.floor(performanceState.voiceLatencies.length / 2)]);

    const payload = {
        reportType: 'Hype Man Incident and Session Report',
        exportedAt: new Date().toISOString(),
        sessionStartedAt: sessionStats.startedAt,
        personaMode: getPersonaStatusLabel(),
        executiveSummary: {
            pipelineHealth: diagnosticsSummary.failedRuns === 0 ? 'stable' : 'needs attention',
            operatingMode: diagnosticsState.mode,
            activeScenario: diagnosticsState.scenario,
            medianLatencyMs: getMedianLatency(),
        },
        diagnostics: {
            mode: diagnosticsState.mode,
            scenario: diagnosticsState.scenario,
            latencyMs: diagnosticsState.latencyMs,
            summary: diagnosticsSummary,
            runs: diagnosticsState.runs,
        },
        summary: {
            eventsSeen: sessionStats.eventsSeen,
            hypeCalls: sessionStats.hypeCalls,
            medianLatencyMs: getMedianLatency(),
            medianClassifyLatencyMs: medianClassifyLatency,
            medianVoiceLatencyMs: medianVoiceLatency,
        },
        companion: {
            feedbackProfile,
            feedbackEntries: companionState.feedbackEntries,
            memories: companionState.memories,
        },
        findings: diagnosticsState.runs
            .filter((run) => !run.passed)
            .map((run) => ({
                severity: 'high',
                scenario: run.scenario,
                detail: run.detail,
                observedAt: run.ranAt,
            })),
        evidence: sessionEvidence,
    };

    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `hype-session-${Date.now()}.json`;
    link.click();
    URL.revokeObjectURL(url);
    log({
        stage: 'System',
        level: 'success',
        title: 'Session exported',
        detail: 'A JSON report with diagnostics, evidence, and summary metrics was downloaded.',
    });
}

async function selectSource(sourceId) {
    cleanupRuntimeState();
    const sourceSelect = document.getElementById('video-source');
    const sourceLabel = sourceSelect?.selectedOptions?.[0]?.text || sourceId;
    log({
        stage: 'Capture',
        level: 'info',
        title: 'Source selected',
        detail: `Connecting to ${sourceLabel} for screen and system-audio monitoring.`,
    });
    updateSourceBadge(sourceLabel);
    setPipelinePhase('Connecting', 'Requesting desktop capture and audio permissions.', '#62d7ff');

    try {
        const stream = await navigator.mediaDevices.getUserMedia({
            audio: {
                mandatory: {
                    chromeMediaSource: 'desktop',
                    chromeMediaSourceId: sourceId
                }
            },
            video: {
                mandatory: {
                    chromeMediaSource: 'desktop',
                    chromeMediaSourceId: sourceId,
                    minWidth: 1280, maxWidth: 1920,
                    minHeight: 720, maxHeight: 1080
                }
            }
        });
        captureStream = stream;

        // Initialize Audio Analyser
        audioContext = new (window.AudioContext || window.webkitAudioContext)();
        const source = audioContext.createMediaStreamSource(stream);
        analyser = audioContext.createAnalyser();
        analyser.fftSize = 256;
        source.connect(analyser);
        dataArray = new Uint8Array(analyser.frequencyBinCount);

        const video = document.getElementById('video-feed');
        video.srcObject = stream;
        video.onloadedmetadata = () => {
            video.play();
            log({
                stage: 'Capture',
                level: 'success',
                title: 'Live capture connected',
                detail: 'Screen frames and audio levels are now streaming into the hype pipeline.',
            });
            updateSourceBadge(sourceLabel);
            setConfidenceBadge('Monitoring for spikes');
            setPipelinePhase('Watching', 'Live capture is active and waiting for a meaningful moment.', '#00e5ff');
            startDiffLoop(video);
        };
    } catch (e) {
        log({
            stage: 'Capture',
            level: 'error',
            title: 'Capture connection failed',
            detail: `Desktop capture did not start. Make sure system audio is shared. ${e.message}`,
        });
        setPipelinePhase('Capture Error', 'Desktop capture failed. Re-select the source and include system audio.', '#ff6a6a');
    }
}

function startDiffLoop(video) {
    const diffCanvas = document.getElementById('diff-canvas');
    const diffCtx = diffCanvas.getContext('2d', { willReadFrequently: true });
    const loop = (timestamp) => {
        analysisFrameId = window.requestAnimationFrame(loop);
        if (video.videoWidth === 0) return;
        if (timestamp - lastAnalysisTick < DIFF_CHECK_INTERVAL_MS) return;
        lastAnalysisTick = timestamp;

        const rawDiff = computeFrameDiff(diffCtx, diffCanvas, video);
        const visualPct = window.HypeCore.clamp((rawDiff / 255) * 100, 0, 100);

        let currentAudioPeak = 0;
        if (analyser && dataArray) {
            analyser.getByteFrequencyData(dataArray);
            let sum = 0;
            for (let i = 0; i < dataArray.length; i++) sum += dataArray[i];
            currentAudioPeak = (sum / dataArray.length) / 255;
            lastAudioPeak = currentAudioPeak;
        }

        const audioPct = window.HypeCore.clamp(currentAudioPeak * 100, 0, 100);
        const combinedIntensity = window.HypeCore.computeIntensity(visualPct, audioPct);

        smoothedDiffPct = window.HypeCore.smoothValue(smoothedDiffPct, visualPct, VISUAL_SMOOTHING);
        smoothedAudioPct = window.HypeCore.smoothValue(smoothedAudioPct, audioPct, AUDIO_SMOOTHING);
        smoothedIntensityPct = window.HypeCore.smoothValue(smoothedIntensityPct, combinedIntensity, INTENSITY_SMOOTHING);

        setDiffMeter(smoothedDiffPct);
        setAudioMeter(smoothedAudioPct);
        setIntensityMeter(smoothedIntensityPct);

        const isVisualSpike = rawDiff >= DIFF_THRESHOLD || smoothedDiffPct >= 18;
        const isAudioSpike = currentAudioPeak >= AUDIO_THRESHOLD || smoothedAudioPct >= 24;

        if (isVisualSpike) {
            spikeCount++;
        } else {
            spikeCount = 0;
        }

        const signalState = window.HypeCore.classifySignalState(smoothedIntensityPct);
        if (signalState === 'high') {
            setConfidenceBadge('High-conviction moment');
        } else if (signalState === 'building') {
            setConfidenceBadge('Pressure building');
        } else {
            setConfidenceBadge('Monitoring for spikes');
        }

        const shouldTrackCandidate = window.HypeCore.shouldStartMomentCandidate({
            signalState,
            isAudioSpike,
            isVisualSpike,
        });

        if (!activeMomentCandidate && shouldTrackCandidate) {
            activeMomentCandidate = {
                startedAt: timestamp,
                peakAt: timestamp,
                quietFrames: 0,
                armed: false,
                peakDiffPct: smoothedDiffPct,
                peakAudioPeak: currentAudioPeak,
                peakIntensityPct: smoothedIntensityPct,
                peakSignalState: signalState,
            };
        }

        if (activeMomentCandidate) {
            if (smoothedIntensityPct >= activeMomentCandidate.peakIntensityPct) {
                activeMomentCandidate.peakAt = timestamp;
                activeMomentCandidate.peakDiffPct = smoothedDiffPct;
                activeMomentCandidate.peakAudioPeak = currentAudioPeak;
                activeMomentCandidate.peakIntensityPct = smoothedIntensityPct;
                activeMomentCandidate.peakSignalState = signalState;
            }

            if (shouldTrackCandidate) {
                activeMomentCandidate.quietFrames = 0;
            } else {
                activeMomentCandidate.quietFrames += 1;
            }

            const sustainedTrigger = window.HypeCore.shouldQueueMoment({
                spikeCount,
                consecutiveSpikesNeeded: CONSECUTIVE_SPIKES_NEEDED,
                isAudioSpike,
            });
            if (sustainedTrigger) {
                activeMomentCandidate.armed = true;
            }

            const shouldFinalize = activeMomentCandidate.armed && window.HypeCore.shouldFinalizeMomentCandidate({
                signalState,
                activeForMs: timestamp - activeMomentCandidate.startedAt,
                quietFrames: activeMomentCandidate.quietFrames,
                peakIntensity: activeMomentCandidate.peakIntensityPct,
            });

            if (shouldFinalize) {
                spikeCount = 0;
                const candidate = activeMomentCandidate;
                activeMomentCandidate = null;
                addToHypeQueue(candidate.peakDiffPct, candidate.peakAudioPeak, {
                    intensityPct: candidate.peakIntensityPct,
                    timestamp: Date.now(),
                    source: 'auto',
                });
            }
        }

        if (!shouldTrackCandidate && signalState === 'idle' && !activeMomentCandidate) {
            spikeCount = 0;
        }
    };

    analysisFrameId = window.requestAnimationFrame(loop);
}

async function runDiagnosticsScenario(scenario, latencyMs) {
    const previousMode = diagnosticsState.mode;
    const previousScenario = diagnosticsState.scenario;
    const previousLatency = diagnosticsState.latencyMs;

    diagnosticsState.mode = 'mock';
    diagnosticsState.scenario = scenario;
    diagnosticsState.latencyMs = latencyMs;

    const startedAt = Date.now();
    let passed = false;
    let detail = '';

    try {
        const persona = choosePersonaForItem({ diffPct: 72, audioPeak: 0.4, source: 'manual' });
        const response = await requestGeminiAnalysis(
            { diffPct: 72, audioPeak: 0.4, source: 'manual', base64Data: 'mock' },
            window.HypeCore.buildSystemPrompt({ diffPct: 72, audioPeak: 0.4 }, persona, []),
            persona
        );

        if (scenario === 'rate-limit') {
            passed = response.status === 429;
            detail = passed ? 'Rate limit surfaced correctly.' : 'Expected 429.';
        } else if (scenario === 'empty-model') {
            passed = !response.payload?.candidates?.length;
            detail = passed ? 'Empty candidate payload handled.' : 'Expected empty candidates.';
        } else if (scenario === 'malformed-json') {
            const rawText = response.payload?.candidates?.[0]?.content?.parts?.[0]?.text || '';
            const parsed = window.HypeCore.safeParseModelResponse(rawText);
            passed = parsed.ok === false;
            detail = passed ? 'Malformed JSON rejected safely.' : 'Malformed JSON unexpectedly parsed.';
        } else {
            const rawText = response.payload?.candidates?.[0]?.content?.parts?.[0]?.text || '';
            const parsed = window.HypeCore.safeParseModelResponse(rawText);
            passed = parsed.ok === true;
            detail = passed ? 'Stable response path passed.' : 'Expected valid parsed payload.';
        }

        if (passed && scenario === 'audio-failure') {
            try {
                await requestVoicePlayback('Diagnostics voice check');
                passed = false;
                detail = 'Expected injected audio failure.';
            } catch (error) {
                passed = true;
                detail = 'Audio failure surfaced correctly.';
            }
        }
    } catch (error) {
        detail = error.message;
    } finally {
        diagnosticsState.mode = previousMode;
        diagnosticsState.scenario = previousScenario;
        diagnosticsState.latencyMs = previousLatency;
    }

    const result = {
        scenario,
        latencyMs,
        passed,
        detail,
        durationMs: Date.now() - startedAt,
        ranAt: new Date().toISOString(),
    };
    diagnosticsState.runs.push(result);
    renderDiagnosticsResults();
    return result;
}

async function runDiagnosticsSuite() {
    const scenarios = [
        ['stable', 0],
        ['slow-success', 750],
        ['malformed-json', 0],
        ['rate-limit', 0],
        ['empty-model', 0],
        ['audio-failure', 250],
    ];

    updateDiagnosticsHealth('Running', 'Diagnostics suite is exercising mocked transport scenarios.');
    setPipelinePhase('Diagnostics', 'Running mocked transport scenarios for resilience verification.', '#ffbf69');

    const results = [];
    for (const [scenario, latencyMs] of scenarios) {
        const result = await runDiagnosticsScenario(scenario, latencyMs);
        results.push(result);
        log({
            stage: 'Diagnostics',
            level: result.passed ? 'success' : 'warn',
            title: `${scenario} ${result.passed ? 'passed' : 'flagged'}`,
            detail: result.detail,
            metrics: [`Duration ${result.durationMs}ms`, `Injected latency ${result.latencyMs}ms`],
        });
    }

    const passCount = results.filter((result) => result.passed).length;
    const summary = `${passCount}/${results.length} scenarios passed. Latest: ${results[results.length - 1].detail}`;
    updateDiagnosticsHealth(passCount === results.length ? 'Passing' : 'Attention', summary);
    setPipelinePhase('Watching', 'Diagnostics complete. Live capture remains available.', '#00e5ff');
}

async function injectCurrentScenario() {
    const result = await runDiagnosticsScenario(diagnosticsState.scenario, diagnosticsState.latencyMs);
    updateDiagnosticsHealth(result.passed ? 'Passing' : 'Attention', `${result.scenario}: ${result.detail}`);
    log({
        stage: 'Diagnostics',
        level: result.passed ? 'success' : 'warn',
        title: `Injected ${result.scenario}`,
        detail: result.detail,
        metrics: [`Duration ${result.durationMs}ms`, `Injected latency ${result.latencyMs}ms`],
    });
}

async function callGemini(item) {
    if (!env?.GEMINI_API_KEY) return false;
    setPipelinePhase('Analyzing', 'Interpreting the live frame and checking whether the moment deserves a reaction.', '#ffeb3b');

    const persona = choosePersonaForItem(item);
    const recentHypes = window._recentHypes || [];
    const feedbackProfile = getFeedbackProfile();
    const memoryCallbacks = window.HypeCore.pickMemoryCallbacks(companionState.memories, item, 2);
    const systemPrompt = window.HypeCore.buildSystemPrompt(item, persona, recentHypes, {
        feedbackProfile,
        memories: companionState.memories,
        memoryCallbacks,
    });

    try {
        const classifyStartedAt = performance.now();
        const response = await requestGeminiAnalysis(item, systemPrompt, persona);
        const classifyLatencyMs = Math.round(performance.now() - classifyStartedAt);
        performanceState.classifyLatencies.push(classifyLatencyMs);
        performanceState.classifyLatencies = performanceState.classifyLatencies.slice(-30);
        const limit = response.headers?.limit;
        const remaining = response.headers?.remaining;
        log({
            stage: 'Network',
            level: response.status >= 200 && response.status < 300 ? 'info' : 'warn',
            title: 'Gemini responded',
            detail: 'The classifier transport returned a response for the queued moment.',
            metrics: [`HTTP ${response.status}`, `Remaining ${remaining || '?'}/${limit || '?'}`, `Classify ${classifyLatencyMs}ms`],
        });

        if (response.status === 429) {
            log({
                stage: 'Network',
                level: 'warn',
                title: 'Rate limit hit',
                detail: 'The app is backing off before retrying the same moment.',
            });
            lastGeminiCallTime = Date.now();
            return false;
        }
        if (response.status < 200 || response.status >= 300) {
            throw new Error(`HTTP ${response.status}`);
        }

        const data = response.payload;
        if (!data?.candidates?.[0]) {
            log({
                stage: 'Network',
                level: 'warn',
                title: 'Model returned no candidate',
                detail: 'Gemini answered without usable content for this moment.',
            });
            return true;
        }

        const rawText = data.candidates[0].content.parts[0].text || '';
        const parsed = window.HypeCore.safeParseModelResponse(rawText);
        if (!parsed.ok) throw new Error(parsed.error);

        const hypeData = parsed.data;
        lastGeminiCallTime = Date.now();
        const latencyMs = Date.now() - item.timestamp;
        sessionStats.latencySamples.push(latencyMs);
        const reactionId = `reaction-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`;

        if (hypeData.isHypeWorthy && hypeData.reaction) {
            const rememberedMoment = rememberMoment({
                id: `memory-${reactionId}`,
                capturedAt: new Date().toISOString(),
                situation: hypeData.situation,
                category: hypeData.category,
                reaction: hypeData.reaction,
                source: item.source || 'auto',
                persona: persona.label,
                intensityPct: item.intensityPct || Math.round(item.diffPct),
            });
            setLatestReactionContext({
                id: reactionId,
                memoryId: rememberedMoment?.id || null,
                situation: hypeData.situation,
                category: hypeData.category,
                reaction: hypeData.reaction,
                persona: persona.label,
                intensityPct: item.intensityPct || Math.round(item.diffPct),
                feedbackLabel: rememberedMoment?.feedbackLabel || null,
            });
            log({
                stage: 'Hype',
                level: 'success',
                title: 'Reaction approved',
                detail: hypeData.reaction,
                metrics: [persona.label, hypeData.category, `${latencyMs}ms end-to-end`, `${classifyLatencyMs}ms classify`],
            });
            setStatus(`"${hypeData.reaction}"`, '#ff9800');
            if (!window._recentHypes) window._recentHypes = [];
            window._recentHypes.push(hypeData.reaction);
            if (window._recentHypes.length > 5) window._recentHypes.shift();
            sessionStats.hypeCalls++;
            updateStatsUI();
            setConfidenceBadge('Moment validated');
            recordEvidence({
                type: 'hype',
                source: item.source || 'auto',
                situation: hypeData.situation,
                category: hypeData.category,
                persona: persona.label,
                reaction: hypeData.reaction,
                diffPct: Math.round(item.diffPct),
                audioPeakPct: Math.round(item.audioPeak * 100),
                latencyMs,
                classifyLatencyMs,
                memoryCallbacks,
                feedbackBias: feedbackProfile.restraintBias,
                transportMode: diagnosticsState.mode,
                diagnosticsScenario: diagnosticsState.scenario,
            });
            addLogEntry(hypeData.situation, hypeData.category, hypeData.reaction, item.diffPct, item.audioPeak, persona.label);
            const speakDelayMs = window.HypeCore.computeSpeakDelayMs({
                intensityPct: item.intensityPct || Math.round(item.diffPct),
                queueDepth: hypeQueue.length,
                source: item.source || 'auto',
                feedbackProfile,
            });
            await wait(speakDelayMs);
            await playElevenLabsAudio(hypeData.reaction, { speakDelayMs, reactionId });
        } else {
            setLatestReactionContext(null);
            log({
                stage: 'Hype',
                level: 'info',
                title: 'Moment passed',
                detail: hypeData.situation,
                metrics: [persona.label, hypeData.category || 'General', `${classifyLatencyMs}ms classify`],
            });
            setConfidenceBadge('Classifier passed');
            addLogEntry(hypeData.situation, hypeData.category, '-', item.diffPct, item.audioPeak, persona.label);
        }

        return true;
    } catch (e) {
        log({
            stage: 'Network',
            level: 'error',
            title: 'Classification failed',
            detail: e.message,
        });
        lastGeminiCallTime = Date.now();
        return false;
    }
}

async function playElevenLabsAudio(text, options = {}) {
    try {
        if (!env?.ELEVENLABS_API_KEY && diagnosticsState.mode !== 'mock') {
            log({
                stage: 'Audio',
                level: 'warn',
                title: 'Voice skipped',
                detail: 'ElevenLabs is not configured, so reactions stay text-only.',
            });
            return;
        }

        log({
            stage: 'Audio',
            level: 'info',
            title: 'Synthesizing voice',
            detail: 'Preparing the spoken version of the approved reaction.',
        });
        const voiceStartedAt = performance.now();
        const playback = await requestVoicePlayback(text);
        if (playback.mock) {
            setPipelinePhase('Speaking', 'Mock voice playback completed for diagnostics.', '#53f1cf');
            log({
                stage: 'Audio',
                level: 'success',
                title: 'Mock voice completed',
                detail: 'Diagnostics finished the voice step without live audio output.',
            });
            return;
        }

        if (activeAudio) {
            activeAudio.pause();
            activeAudio.src = '';
        }
        activeAudio = new Audio(playback.audioUrl);
        activeAudio.onended = () => URL.revokeObjectURL(playback.audioUrl);
        activeAudio.play();
        setPipelinePhase('Speaking', 'Delivering the reaction through voice playback.', '#53f1cf');
        const voiceLatencyMs = Math.round(performance.now() - voiceStartedAt);
        performanceState.voiceLatencies.push(voiceLatencyMs);
        performanceState.voiceLatencies = performanceState.voiceLatencies.slice(-30);
        log({
            stage: 'Audio',
            level: 'success',
            title: 'Voice playback started',
            detail: 'The approved reaction is now being spoken aloud.',
            metrics: [`Voice ${voiceLatencyMs}ms`, options.speakDelayMs ? `Delay ${options.speakDelayMs}ms` : ''],
        });
    } catch (e) {
        log({
            stage: 'Audio',
            level: 'error',
            title: 'Audio playback failed',
            detail: e.message,
        });
    }
}

// ─── INIT ────────────────────────────────────────────────────────────────────
function wireControls() {
    const manualBtn = document.getElementById('manual-hype-btn');
    const exportBtn = document.getElementById('export-session-btn');
    const personaSelect = document.getElementById('persona-select');
    const diagnosticsMode = document.getElementById('diagnostics-mode');
    const diagnosticsScenario = document.getElementById('diagnostics-scenario');
    const diagnosticsLatency = document.getElementById('diagnostics-latency');
    const runDiagnosticsBtn = document.getElementById('run-diagnostics-btn');
    const injectFailureBtn = document.getElementById('inject-failure-btn');
    const tabButtons = document.querySelectorAll('[data-ops-tab]');
    const runtimeFilters = document.querySelectorAll('[data-runtime-filter]');
    const feedbackButtons = document.querySelectorAll('[data-feedback-label]');

    if (manualBtn) {
        manualBtn.onclick = () => queueManualHype();
    }

    if (exportBtn) {
        exportBtn.onclick = () => exportSessionEvidence();
    }

    if (personaSelect) {
        personaSelect.value = selectedPersonaKey;
        personaSelect.onchange = () => {
            selectedPersonaKey = personaSelect.value;
            log({
                stage: 'System',
                level: 'info',
                title: 'Persona changed',
                detail: `Reactions will now use ${getPersonaStatusLabel()}.`,
            });
            updatePersonaBadge();
            setPipelinePhase('Persona Updated', `Reactions will now use ${getPersonaStatusLabel()}.`, '#8bc34a');
        };
    }

    if (diagnosticsMode) {
        diagnosticsMode.value = diagnosticsState.mode;
        diagnosticsMode.onchange = () => {
            diagnosticsState.mode = diagnosticsMode.value;
            updateDiagnosticsHealth(
                diagnosticsState.mode === 'mock' ? 'Mock Mode' : 'Live Mode',
                diagnosticsState.mode === 'mock'
                    ? 'Live transports replaced with deterministic mocks.'
                    : 'Using production Gemini and ElevenLabs transports.'
            );
            log({
                stage: 'Diagnostics',
                level: 'info',
                title: diagnosticsState.mode === 'mock' ? 'Mock transport enabled' : 'Live transport enabled',
                detail: diagnosticsState.mode === 'mock'
                    ? 'The runtime now uses deterministic diagnostics responses.'
                    : 'The runtime is back on Gemini and ElevenLabs transports.',
            });
        };
    }

    if (diagnosticsScenario) {
        diagnosticsScenario.value = diagnosticsState.scenario;
        diagnosticsScenario.onchange = () => {
            diagnosticsState.scenario = diagnosticsScenario.value;
        };
    }

    if (diagnosticsLatency) {
        diagnosticsLatency.value = String(diagnosticsState.latencyMs);
        diagnosticsLatency.onchange = () => {
            diagnosticsState.latencyMs = Number(diagnosticsLatency.value);
        };
    }

    if (runDiagnosticsBtn) {
        runDiagnosticsBtn.onclick = () => runDiagnosticsSuite();
    }

    if (injectFailureBtn) {
        injectFailureBtn.onclick = () => injectCurrentScenario();
    }

    tabButtons.forEach((button) => {
        button.onclick = () => setOperationsTab(button.dataset.opsTab);
    });

    runtimeFilters.forEach((button) => {
        button.onclick = () => setRuntimeFilter(button.dataset.runtimeFilter);
    });

    feedbackButtons.forEach((button) => {
        button.onclick = () => recordReactionFeedback(button.dataset.feedbackLabel);
    });

    setOperationsTab('runtime');
    setRuntimeFilter(runtimeState.activeFilter);
    syncCompanionPanels();

    window.addEventListener('keydown', (event) => {
        const target = event.target;
        const isTyping = target && ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName);
        if (isTyping) return;

        if (event.code === 'Space') {
            event.preventDefault();
            queueManualHype();
        }
    });
}

async function start() {
    wireControls();
    loadCompanionState();
    updatePersonaBadge();
    updateSourceBadge('Awaiting source selection');
    setConfidenceBadge('Confidence building');
    updateDiagnosticsHealth('Idle', 'No diagnostics run yet in this session.');
    renderDiagnosticsResults();
    renderRuntimeFeed();
    log({
        stage: 'System',
        level: 'info',
        title: 'Loading environment',
        detail: 'Fetching API keys from the Electron main process.',
    });
    env = await window.electronAPI.getEnv();

    if (!env.GEMINI_API_KEY) {
        log({
            stage: 'System',
            level: 'error',
            title: 'Gemini key missing',
            detail: 'Add GEMINI_API_KEY to the local .env file before running live classification.',
        });
        setPipelinePhase('Missing API Key', 'Gemini is required for classification and reaction generation.', '#ff6a6a');
        return;
    }
    if (!env.ELEVENLABS_API_KEY) {
        log({
            stage: 'Audio',
            level: 'warn',
            title: 'Voice key missing',
            detail: 'Live classification still works, but spoken reactions are disabled until ELEVENLABS_API_KEY is set.',
        });
    } else {
        primeVoiceChoice().then((voiceId) => {
            if (voiceId) {
                log({
                    stage: 'Audio',
                    level: 'info',
                    title: 'Voice cache primed',
                    detail: 'The preferred ElevenLabs voice was fetched ahead of the next reaction.',
                });
            }
        }).catch(() => {});
    }

    log({
        stage: 'Capture',
        level: 'info',
        title: 'Loading capture sources',
        detail: 'Querying Electron for available screens and windows.',
    });
    const sources = await window.electronAPI.getSources();
    const select = document.getElementById('video-source');
    select.innerHTML = '';
    sources.forEach(source => {
        const opt = document.createElement('option');
        opt.value = source.id;
        opt.text = source.name;
        select.appendChild(opt);
    });
    select.onchange = () => selectSource(select.value);
    if (sources.length > 0) {
        selectSource(sources[0].id);
    } else {
        setPipelinePhase('No Sources', 'No desktop sources were returned by Electron capture.', '#ff6a6a');
    }
}

updateStatsUI();
window.addEventListener('error', (event) => {
    log({
        stage: 'System',
        level: 'error',
        title: 'Unhandled renderer error',
        detail: event.message,
    });
    setPipelinePhase('Runtime Error', 'An unexpected renderer error occurred. Check the runtime log.', '#ff6a6a');
});
window.addEventListener('unhandledrejection', (event) => {
    const reason = event.reason instanceof Error ? event.reason.message : String(event.reason);
    log({
        stage: 'System',
        level: 'error',
        title: 'Unhandled async rejection',
        detail: reason,
    });
    setPipelinePhase('Runtime Error', 'An unexpected async error occurred. Check the runtime log.', '#ff6a6a');
});
start().catch((error) => {
    log({
        stage: 'System',
        level: 'error',
        title: 'Startup failed',
        detail: error.message,
    });
    setPipelinePhase('Startup Error', 'Initialization failed before live capture could start.', '#ff6a6a');
});
window.addEventListener('beforeunload', cleanupRuntimeState);


