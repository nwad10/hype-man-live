const {
    smoothValue,
    computeIntensity,
    classifySignalState,
    shouldQueueMoment,
    safeParseModelResponse,
    nextCooldown,
} = require('../src/renderer/hype-core.js');

const ITERATIONS = 50000;
let smoothedDiff = 0;
let smoothedAudio = 0;
let smoothedIntensity = 0;
let spikeCount = 0;
let queued = 0;
let highMoments = 0;
let cooldown = 35000;

const start = performance.now();

for (let i = 0; i < ITERATIONS; i += 1) {
    const visual = (Math.sin(i / 18) + 1) * 40 + (i % 113 === 0 ? 28 : 0);
    const audio = (Math.cos(i / 31) + 1) * 25 + (i % 149 === 0 ? 42 : 0);

    smoothedDiff = smoothValue(smoothedDiff, visual, 0.24);
    smoothedAudio = smoothValue(smoothedAudio, audio, 0.28);
    smoothedIntensity = smoothValue(smoothedIntensity, computeIntensity(smoothedDiff, smoothedAudio), 0.22);

    const signalState = classifySignalState(smoothedIntensity);
    if (signalState === 'high') highMoments += 1;

    const isVisualSpike = smoothedDiff >= 18;
    const isAudioSpike = smoothedAudio >= 24;
    spikeCount = isVisualSpike ? spikeCount + 1 : 0;

    if (shouldQueueMoment({ spikeCount, consecutiveSpikesNeeded: 4, isAudioSpike })) {
        queued += 1;
        spikeCount = 0;
    }

    if (i % 250 === 0) {
        const parsed = safeParseModelResponse('{"isHypeWorthy":true,"reaction":"Cooked","situation":"Big swing","category":"General"}');
        if (!parsed.ok) throw new Error('Smoke parse failed unexpectedly.');
    }

    cooldown = nextCooldown(cooldown, {
        success: i % 7 !== 0,
        baseCooldown: 35000,
        maxCooldown: 90000,
    });
}

const durationMs = performance.now() - start;
const perIterationUs = (durationMs * 1000) / ITERATIONS;

console.log(JSON.stringify({
    iterations: ITERATIONS,
    durationMs: Number(durationMs.toFixed(2)),
    perIterationUs: Number(perIterationUs.toFixed(3)),
    queued,
    highMoments,
    finalCooldown: cooldown,
}, null, 2));
