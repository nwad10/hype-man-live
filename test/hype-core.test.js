const test = require('node:test');
const assert = require('node:assert/strict');

const {
    PERSONA_PRESETS,
    choosePersona,
    buildFeedbackProfile,
    pickMemoryCallbacks,
    buildMemoryPromptContext,
    buildSystemPrompt,
    computeSpeakDelayMs,
    extractJsonObject,
    safeParseModelResponse,
    normalizeHypeData,
    smoothValue,
    computeIntensity,
    classifySignalState,
    shouldQueueMoment,
    shouldStartMomentCandidate,
    shouldFinalizeMomentCandidate,
    nextCooldown,
} = require('../src/renderer/hype-core.js');

test('auto persona selection prefers play-by-play for loud moments', () => {
    const persona = choosePersona({ diffPct: 20, audioPeak: 0.7, source: 'auto' }, 'auto');
    assert.equal(persona.label, PERSONA_PRESETS['play-by-play'].label);
});

test('auto persona selection prefers founder mode for manual trigger', () => {
    const persona = choosePersona({ diffPct: 100, audioPeak: 0.1, source: 'manual' }, 'auto');
    assert.equal(persona.label, PERSONA_PRESETS['founder-mode'].label);
});

test('feedback profile summarizes player taste', () => {
    const profile = buildFeedbackProfile([
        { label: 'nailed-it' },
        { label: 'too-much' },
        { label: 'too-much' },
        { label: 'missed-it' },
    ]);

    assert.equal(profile.total, 4);
    assert.equal(profile.restraintBias, 'more restraint');
    assert.match(profile.specificityBias, /specific/i);
});

test('memory callback picker favors matching and validated moments', () => {
    const memories = [
        { situation: 'Perfect parry', reaction: 'That was filthy.', category: 'Action', intensityPct: 78, feedbackLabel: 'nailed-it', playCount: 2 },
        { situation: 'Slow creep', reaction: 'Steady now.', category: 'Stealth', intensityPct: 25, feedbackLabel: null, playCount: 1 },
    ];
    const picked = pickMemoryCallbacks(memories, { category: 'Action', intensityPct: 72 }, 1);

    assert.equal(picked.length, 1);
    assert.equal(picked[0].situation, 'Perfect parry');
});

test('memory prompt context includes reactions, taste, and callbacks', () => {
    const context = buildMemoryPromptContext({
        recentHypes: ['What a save'],
        feedbackProfile: buildFeedbackProfile([{ label: 'nailed-it' }, { label: 'missed-it' }]),
        memoryCallbacks: [{ situation: 'Last-second clutch', reaction: 'You still have that in you.' }],
    });

    assert.match(context, /Recent reactions to avoid repeating/);
    assert.match(context, /Player taste profile/);
    assert.match(context, /Last-second clutch/);
});

test('system prompt includes witness framing, feedback, and memory context', () => {
    const persona = PERSONA_PRESETS['locker-room'];
    const prompt = buildSystemPrompt(
        { diffPct: 63, audioPeak: 0.32, intensityPct: 68 },
        persona,
        ['Huge save'],
        {
            feedbackProfile: buildFeedbackProfile([{ label: 'too-much' }]),
            memories: [{ situation: 'Old comeback', reaction: 'There it is again.', category: 'Gaming', intensityPct: 66, feedbackLabel: 'nailed-it' }],
        }
    );

    assert.match(prompt, /solo-gaming witness companion/i);
    assert.match(prompt, /Keep reaction under 12 words/);
    assert.match(prompt, /Old comeback/);
    assert.match(prompt, /lean more restraint/i);
});

test('speak delay gets faster for stronger moments and manual triggers', () => {
    const slow = computeSpeakDelayMs({ intensityPct: 28, queueDepth: 0, source: 'auto' });
    const fast = computeSpeakDelayMs({ intensityPct: 82, queueDepth: 1, source: 'manual' });

    assert.ok(slow > fast);
    assert.ok(fast >= 70);
});

test('json extraction strips wrappers safely', () => {
    const extracted = extractJsonObject('```json\n{"isHypeWorthy":true}\n```');
    assert.equal(extracted, '{"isHypeWorthy":true}');
});

test('normalizeHypeData falls back safely', () => {
    const normalized = normalizeHypeData({ isHypeWorthy: true, reaction: ' Let him cook ' });
    assert.equal(normalized.isHypeWorthy, true);
    assert.equal(normalized.reaction, 'Let him cook');
    assert.equal(normalized.situation, 'Unclassified moment');
    assert.equal(normalized.category, 'General');
});

test('smoothValue keeps transitions bounded', () => {
    const smoothed = smoothValue(20, 80, 0.25);
    assert.equal(smoothed, 35);
});

test('computeIntensity blends visual and audio percentages', () => {
    assert.equal(computeIntensity(80, 20), 57.2);
});

test('classifySignalState buckets intensity cleanly', () => {
    assert.equal(classifySignalState(20), 'idle');
    assert.equal(classifySignalState(40), 'building');
    assert.equal(classifySignalState(75), 'high');
});

test('moment candidate helpers start on spikes and finalize after the peak settles', () => {
    assert.equal(shouldStartMomentCandidate({ signalState: 'building', isAudioSpike: false, isVisualSpike: false }), true);
    assert.equal(shouldStartMomentCandidate({ signalState: 'idle', isAudioSpike: false, isVisualSpike: false }), false);
    assert.equal(
        shouldFinalizeMomentCandidate({ signalState: 'idle', activeForMs: 420, quietFrames: 2, peakIntensity: 66 }),
        true
    );
    assert.equal(
        shouldFinalizeMomentCandidate({ signalState: 'high', activeForMs: 180, quietFrames: 0, peakIntensity: 84 }),
        false
    );
});

test('shouldQueueMoment triggers on sustained or audio spikes', () => {
    assert.equal(shouldQueueMoment({ spikeCount: 4, consecutiveSpikesNeeded: 4, isAudioSpike: false }), true);
    assert.equal(shouldQueueMoment({ spikeCount: 1, consecutiveSpikesNeeded: 4, isAudioSpike: true }), true);
    assert.equal(shouldQueueMoment({ spikeCount: 1, consecutiveSpikesNeeded: 4, isAudioSpike: false }), false);
});

test('safeParseModelResponse tolerates wrapper text and malformed payloads', () => {
    const good = safeParseModelResponse('preface {"isHypeWorthy":true,"reaction":"Bang","situation":"Goal","category":"Gaming"} tail');
    assert.equal(good.ok, true);
    assert.equal(good.data.reaction, 'Bang');

    const bad = safeParseModelResponse('not json at all');
    assert.equal(bad.ok, false);
    assert.equal(bad.data.situation, 'Unclassified moment');
});

test('nextCooldown applies bounded backoff and recovery', () => {
    assert.equal(nextCooldown(35000, { success: false, baseCooldown: 35000, maxCooldown: 90000 }), 50000);
    assert.equal(nextCooldown(50000, { success: true, baseCooldown: 35000, maxCooldown: 90000 }), 45000);
    assert.equal(nextCooldown(36000, { success: true, baseCooldown: 35000, maxCooldown: 90000 }), 35000);
});
