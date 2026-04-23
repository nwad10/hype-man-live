(function (globalScope) {
    const PERSONA_PRESETS = {
        'play-by-play': {
            label: 'Play-by-Play',
            brief: 'A fast, polished shoutcaster calling a clutch highlight.',
            instructions: 'Sound like a sports commentator. Be sharp, vivid, and broadcast-ready. Favor clean excitement over slang.',
            maxWords: 14,
        },
        'best-friend': {
            label: 'Best Friend',
            brief: 'A supportive friend celebrating the moment with you.',
            instructions: 'Sound warm, personal, and encouraging. Celebrate the user without sounding fake or corporate.',
            maxWords: 16,
        },
        'founder-mode': {
            label: 'Founder Mode',
            brief: 'A startup teammate hyping product momentum and execution.',
            instructions: 'Sound like an energized cofounder celebrating momentum, progress, and shipping. Keep it crisp and ambitious.',
            maxWords: 15,
        },
        'locker-room': {
            label: 'Locker Room',
            brief: 'A fired-up coach rallying the room after a big play.',
            instructions: 'Sound intense, clean, and motivating. Use short commands and rallying energy without insults.',
            maxWords: 12,
        },
        'roast-lite': {
            label: 'Roast Lite',
            brief: 'A playful commentator with a little edge.',
            instructions: 'Sound witty and lightly teasing, but never mean, crude, or demeaning. Keep the joke affectionate.',
            maxWords: 14,
        },
    };

    function clamp(value, min, max) {
        return Math.min(max, Math.max(min, value));
    }

    function smoothValue(previous, next, alpha) {
        return (previous * (1 - alpha)) + (next * alpha);
    }

    function computeIntensity(visualPct, audioPct, visualWeight = 0.62) {
        const safeVisualWeight = clamp(visualWeight, 0, 1);
        const safeAudioWeight = 1 - safeVisualWeight;
        return clamp((visualPct * safeVisualWeight) + (audioPct * safeAudioWeight), 0, 100);
    }

    function classifySignalState(intensityPct) {
        if (intensityPct >= 62) return 'high';
        if (intensityPct >= 35) return 'building';
        return 'idle';
    }

    function shouldQueueMoment({ spikeCount, consecutiveSpikesNeeded, isAudioSpike }) {
        return Boolean(spikeCount >= consecutiveSpikesNeeded || isAudioSpike);
    }

    function shouldStartMomentCandidate({ signalState, isAudioSpike, isVisualSpike }) {
        return Boolean(isAudioSpike || isVisualSpike || signalState === 'building' || signalState === 'high');
    }

    function shouldFinalizeMomentCandidate({
        signalState,
        activeForMs,
        quietFrames,
        peakIntensity,
        minHoldMs = 320,
        maxHoldMs = 1250,
        quietFramesNeeded = 2,
    }) {
        if (activeForMs >= maxHoldMs) return true;
        if (peakIntensity >= 72 && quietFrames >= 1 && activeForMs >= minHoldMs) return true;
        if (signalState === 'idle' && quietFrames >= quietFramesNeeded && activeForMs >= minHoldMs) return true;
        return false;
    }

    function getPersonaByKey(key) {
        return PERSONA_PRESETS[key] || PERSONA_PRESETS['play-by-play'];
    }

    function choosePersona(item, selectedPersonaKey) {
        if (selectedPersonaKey !== 'auto') {
            return { key: selectedPersonaKey, ...getPersonaByKey(selectedPersonaKey) };
        }

        if ((item.audioPeak || 0) >= 0.5) {
            return { key: 'play-by-play', ...PERSONA_PRESETS['play-by-play'] };
        }
        if (item.source === 'manual') {
            return { key: 'founder-mode', ...PERSONA_PRESETS['founder-mode'] };
        }
        if ((item.diffPct || 0) >= 60) {
            return { key: 'locker-room', ...PERSONA_PRESETS['locker-room'] };
        }
        if ((item.diffPct || 0) >= 35) {
            return { key: 'roast-lite', ...PERSONA_PRESETS['roast-lite'] };
        }

        return { key: 'best-friend', ...PERSONA_PRESETS['best-friend'] };
    }

    function buildFeedbackProfile(feedbackEntries = []) {
        const counts = {
            nailedIt: 0,
            tooMuch: 0,
            missedIt: 0,
            total: 0,
        };

        for (const entry of feedbackEntries) {
            if (!entry || typeof entry !== 'object') continue;
            if (entry.label === 'nailed-it') counts.nailedIt += 1;
            if (entry.label === 'too-much') counts.tooMuch += 1;
            if (entry.label === 'missed-it') counts.missedIt += 1;
        }

        counts.total = counts.nailedIt + counts.tooMuch + counts.missedIt;
        const restraintBias = counts.tooMuch > counts.nailedIt ? 'more restraint' : counts.missedIt > counts.tooMuch ? 'more presence' : 'balanced';
        const specificityBias = counts.missedIt >= 1 ? 'be more specific to the exact moment' : 'keep reactions concrete and grounded';

        return {
            ...counts,
            restraintBias,
            specificityBias,
        };
    }

    function pickMemoryCallbacks(memories = [], item = {}, limit = 2) {
        if (!Array.isArray(memories) || memories.length === 0) return [];

        const scored = memories
            .filter((memory) => memory && typeof memory === 'object' && memory.situation && memory.reaction)
            .map((memory) => {
                let score = 0;
                if (memory.category && item.category && memory.category === item.category) score += 3;
                if (memory.source && item.source && memory.source === item.source) score += 1;
                if (typeof memory.intensityPct === 'number' && typeof item.intensityPct === 'number') {
                    score += Math.max(0, 3 - Math.abs(memory.intensityPct - item.intensityPct) / 18);
                }
                if (memory.feedbackLabel === 'nailed-it') score += 2;
                if (memory.feedbackLabel === 'too-much') score -= 1.5;
                if (typeof memory.playCount === 'number') score += Math.min(memory.playCount, 2);
                return { memory, score };
            })
            .sort((left, right) => right.score - left.score);

        return scored.slice(0, limit).map((entry) => entry.memory);
    }

    function buildMemoryPromptContext({ recentHypes = [], memoryCallbacks = [], feedbackProfile = null }) {
        const parts = [];

        if (Array.isArray(recentHypes) && recentHypes.length > 0) {
            parts.push(`Recent reactions to avoid repeating: "${recentHypes.join('", "')}"`);
        }

        if (feedbackProfile && feedbackProfile.total > 0) {
            parts.push(`Player taste profile: lean ${feedbackProfile.restraintBias}; ${feedbackProfile.specificityBias}.`);
        }

        if (Array.isArray(memoryCallbacks) && memoryCallbacks.length > 0) {
            const memoryText = memoryCallbacks
                .map((memory) => `${memory.situation} -> "${memory.reaction}"`)
                .join('; ');
            parts.push(`Relevant past moments: ${memoryText}`);
        }

        return parts.join('\n');
    }

    function buildSystemPrompt(item, persona, recentHypes, options = {}) {
        const feedbackProfile = options.feedbackProfile || buildFeedbackProfile([]);
        const memoryCallbacks = options.memoryCallbacks || pickMemoryCallbacks(options.memories || [], item, 2);
        const memoryContext = buildMemoryPromptContext({
            recentHypes,
            memoryCallbacks,
            feedbackProfile,
        });

        return `You are a solo-gaming witness companion reacting to a live gameplay screen capture.
Selected persona: ${persona.label}
Persona brief: ${persona.brief}
Persona instructions: ${persona.instructions}
Vis: ${Math.round(item.diffPct)}%, Aud: ${Math.round((item.audioPeak || 0) * 100)}%, Intensity: ${Math.round(item.intensityPct || item.diffPct || 0)}%.
${memoryContext}
Primary goal:
- Feel like a real friend on the couch who actually saw the moment.
Rules:
- Keep reaction under ${persona.maxWords} words.
- Use one short sentence only.
- Be specific to the exact moment on screen.
- Favor earned validation over constant hype.
- Avoid streamer catchphrases, marketing energy, and generic praise.
- If unsure, stay restrained rather than overselling it.
- If the moment is not actually hype-worthy, set reaction to an empty string.
Return strict JSON: {"isHypeWorthy": bool, "situation": string, "category": string, "reaction": string}`;
    }

    function computeSpeakDelayMs({ intensityPct = 0, queueDepth = 0, source = 'auto', feedbackProfile = null }) {
        let delayMs = 260;

        if (intensityPct >= 80) delayMs = 90;
        else if (intensityPct >= 60) delayMs = 130;
        else if (intensityPct >= 40) delayMs = 180;
        else delayMs = 240;

        if (source === 'manual') delayMs -= 40;
        if (queueDepth > 0) delayMs -= Math.min(queueDepth * 20, 60);
        if (feedbackProfile?.restraintBias === 'more restraint') delayMs += 60;
        if (feedbackProfile?.restraintBias === 'more presence') delayMs -= 20;

        return clamp(Math.round(delayMs), 70, 420);
    }

    function extractJsonObject(text) {
        if (!text || typeof text !== 'string') return null;
        const start = text.indexOf('{');
        const end = text.lastIndexOf('}');
        if (start === -1 || end === -1 || end < start) return null;
        return text.slice(start, end + 1);
    }

    function safeParseModelResponse(text) {
        const jsonText = extractJsonObject(text);
        if (!jsonText) {
            return {
                ok: false,
                error: 'Model returned non-JSON output.',
                data: normalizeHypeData(null),
            };
        }

        try {
            return {
                ok: true,
                error: null,
                data: normalizeHypeData(JSON.parse(jsonText)),
            };
        } catch (error) {
            return {
                ok: false,
                error: error instanceof Error ? error.message : 'JSON parse failed.',
                data: normalizeHypeData(null),
            };
        }
    }

    function normalizeHypeData(payload) {
        const safe = payload && typeof payload === 'object' ? payload : {};
        const situation = typeof safe.situation === 'string' && safe.situation.trim()
            ? safe.situation.trim()
            : 'Unclassified moment';
        const category = typeof safe.category === 'string' && safe.category.trim()
            ? safe.category.trim()
            : 'General';
        const reaction = typeof safe.reaction === 'string' ? safe.reaction.trim() : '';

        return {
            isHypeWorthy: Boolean(safe.isHypeWorthy && reaction),
            situation,
            category,
            reaction,
        };
    }

    function nextCooldown(currentCooldown, { success, baseCooldown, maxCooldown, stepDown = 5000, stepUp = 15000 }) {
        if (success) return Math.max(baseCooldown, currentCooldown - stepDown);
        return Math.min(maxCooldown, currentCooldown + stepUp);
    }

    const api = {
        PERSONA_PRESETS,
        clamp,
        smoothValue,
        computeIntensity,
        classifySignalState,
        shouldQueueMoment,
        shouldStartMomentCandidate,
        shouldFinalizeMomentCandidate,
        getPersonaByKey,
        choosePersona,
        buildFeedbackProfile,
        pickMemoryCallbacks,
        buildMemoryPromptContext,
        buildSystemPrompt,
        computeSpeakDelayMs,
        extractJsonObject,
        safeParseModelResponse,
        normalizeHypeData,
        nextCooldown,
    };

    if (typeof module !== 'undefined' && module.exports) {
        module.exports = api;
    }

    globalScope.HypeCore = api;
})(typeof window !== 'undefined' ? window : globalThis);
