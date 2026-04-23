# Witness Companion Roadmap

## What Was Added In This Pass

- Local feedback loop with `Nailed It`, `Too Much`, and `Missed It`
- Persistent witness memory stored locally across sessions
- Prompt context that now includes player taste and relevant past moments
- Peak-based moment timing so reactions queue closer to the emotional crest instead of the first noisy frame
- Voice prewarming and measured classify/voice latency tracking
- Exported session evidence now includes feedback profile, memories, and latency breakdown

## What To Do Next Without Spending Much

1. Run 10-20 solo play sessions yourself and tag every reaction as `nailed-it`, `too-much`, or `missed-it`.
2. Save exported session reports after each session.
3. Review the reports and pull out:
   - false positives
   - missed clutch moments
   - lines that sounded generic
   - callbacks that felt earned versus forced
4. Turn those into a small labeled dataset for:
   - better trigger timing
   - reaction quality reranking
   - memory callback policies

## Best Use Of A Small Budget

### $1k-$3k

- Pay 10-20 target users for recorded playtests
- Collect reaction ratings and short interviews
- Learn which language feels nostalgic versus cringey

### $3k-$10k

- Hire a senior product engineer to build:
  - a real annotation workflow
  - clip review tooling
  - better local persistence and analytics
  - hybrid local/cloud latency instrumentation

### $10k-$30k

- Build a proper evaluation set:
  - 5k-20k labeled gameplay windows
  - pairwise ratings for reaction quality
  - callback judgments for memory relevance
- Fine-tune or train a lightweight reaction policy / reranker
- Benchmark on target machines to find the minimum viable latency budget

## Latency Reduction Roadmap

### Immediate

- Cache the preferred voice ahead of time
- Keep prompts shorter and more structured
- Move from first-spike triggering to peak-based triggering

### Near-Term

- Pre-capture buffered frames locally so classification starts on the best frame window
- Run moment detection locally and reserve the cloud call for wording only
- Use shorter audio outputs and lower-overhead TTS settings

### Serious Upgrade Path

- Replace cloud classification with a local or hybrid moment detector
- Use a tiny reranker or classifier for:
  - should react
  - how strong
  - when to speak
- Reserve the larger model for only the final line when needed

## What A Paid Developer Should Own

- Event review and labeling tooling
- Dataset schema and storage
- Memory retrieval policy
- Local inference experiments
- Performance profiling on gaming PCs
- Release-quality crash, retry, and observability work

## Product Risks To Watch

- Overreacting kills trust faster than underreacting
- Nostalgia tone can slip into parody if prompts are not grounded
- Good memory callbacks are rare; forced callbacks feel fake
- If end-to-end latency regularly exceeds roughly 1.2s, the “someone saw it with me” illusion weakens
