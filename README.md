# Hype Man Live

Hype Man Live is an Electron app that acts like a real-time witness companion for solo gamers. It watches live screen capture plus system audio, detects meaningful gameplay spikes, and delivers short spoken reactions designed to feel more like an old-school friend on the couch than a content-creator hype bot.

## Why This Project Exists

Most gaming tools are built for streaming, clipping, or sharing. This project explores a different emotional use case:

- solo play that still feels witnessed
- validation in the moment without posting content
- nostalgia-driven companion reactions instead of generic streamer energy

## What It Does

- Captures a live desktop/gameplay source with system audio
- Detects candidate moments from visual motion and audio intensity
- Uses multimodal classification to decide whether a moment is actually worth reacting to
- Speaks a short reaction with persona-aware wording
- Learns locally through `Nailed It`, `Too Much`, and `Missed It` feedback
- Persists witness memory so stronger past moments can influence future reactions
- Includes diagnostics and latency instrumentation for iteration

## Recent Improvements

- Reworked the runtime activity view into a structured operations console
- Added local feedback capture and persistent witness memory
- Shifted trigger timing toward the peak of a moment instead of the first spike
- Added latency-aware speak delays and voice prewarming
- Added a testing and roadmap layer for future product/ML work

## Tech Stack

- Electron
- Vanilla JavaScript
- Gemini API for reaction classification/generation
- ElevenLabs API for spoken playback
- Node test runner for heuristics and prompt utility coverage

## Local Setup

1. Install dependencies:

```bash
npm install
```

2. Copy the environment template and add your keys:

```bash
copy .env.example .env
```

3. Start the app:

```bash
npm start
```

## Scripts

- `npm start` - launch the Electron app
- `npm test` - run unit tests for heuristics and prompt utilities
- `npm run perf:smoke` - run a quick heuristic performance smoke test

## Testing

Current coverage includes:

- persona selection
- witness-style prompt construction
- feedback profile and memory callback helpers
- moment timing helpers
- JSON parsing and normalization
- cooldown/backoff behavior

## Repo Notes

- `.env` is intentionally ignored
- `node_modules` is intentionally ignored
- Product planning and commercialization notes live in `docs/witness-roadmap.md`

## CV / Recruiter Framing

This project is a good example of:

- product-minded prototyping
- real-time event detection
- human-in-the-loop feedback design
- latency-sensitive UX iteration
- multimodal AI product development
