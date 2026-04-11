# Memory Benchmark Report

**Generated:** 2026-04-11
**Environment:** NemoClaw sandbox container
**Token approximation:** 1 token ≈ 4 characters

## Context Window Tokens (Static Cost)

Tokens loaded into the agent's context at session start.

| Entries | Flat (tokens) | Typed Index (tokens) | Savings |
|---------|---------------|----------------------|---------|
|      10 |           734 |                  270 |   63.2% |
|      50 |          3658 |                 1101 |   69.9% |
|     100 |          7313 |                 2142 |   70.7% |
|     500 |         36628 |                10612 |   71.0% |
|    1000 |         73297 |                21249 |   71.0% |
|    5000 |        367402 |               107859 |   70.6% |
|   10000 |        735339 |               216734 |   70.5% |

## Crossover Point

The typed index becomes smaller than the flat file at approximately **10 entries**.
Below this point, the index table header overhead makes the typed format larger.

## Total Session Tokens (Dynamic Cost)

Estimated total tokens per session, including tool call overhead.
Tool call overhead per read: ~80 tokens (request + response wrapper).
Average topic content: ~73 tokens.

### Agent reads 0 topics per session

| Entries | Flat (tokens) | Typed Index (tokens) | Savings |
|---------|---------------|----------------------|---------|
|      10 |           734 |                  270 |   63.2% |
|      50 |          3658 |                 1101 |   69.9% |
|     100 |          7313 |                 2142 |   70.7% |
|     500 |         36628 |                10612 |   71.0% |
|    1000 |         73297 |                21249 |   71.0% |
|    5000 |        367402 |               107859 |   70.6% |
|   10000 |        735339 |               216734 |   70.5% |

### Agent reads 3 topics per session

| Entries | Flat (tokens) | Typed Index (tokens) | Savings |
|---------|---------------|----------------------|---------|
|      10 |           734 |                  729 |    0.7% |
|      50 |          3658 |                 1560 |   57.4% |
|     100 |          7313 |                 2601 |   64.4% |
|     500 |         36628 |                11071 |   69.8% |
|    1000 |         73297 |                21708 |   70.4% |
|    5000 |        367402 |               108318 |   70.5% |
|   10000 |        735339 |               217193 |   70.5% |

### Agent reads 5 topics per session

| Entries | Flat (tokens) | Typed Index (tokens) | Savings |
|---------|---------------|----------------------|---------|
|      10 |           734 |                 1035 | +41.0% (more) |
|      50 |          3658 |                 1866 |   49.0% |
|     100 |          7313 |                 2907 |   60.2% |
|     500 |         36628 |                11377 |   68.9% |
|    1000 |         73297 |                22014 |   70.0% |
|    5000 |        367402 |               108624 |   70.4% |
|   10000 |        735339 |               217499 |   70.4% |

### Agent reads 10 topics per session

| Entries | Flat (tokens) | Typed Index (tokens) | Savings |
|---------|---------------|----------------------|---------|
|      10 |           734 |                 1800 | +145.2% (more) |
|      50 |          3658 |                 2631 |   28.1% |
|     100 |          7313 |                 3672 |   49.8% |
|     500 |         36628 |                12142 |   66.9% |
|    1000 |         73297 |                22779 |   68.9% |
|    5000 |        367402 |               109389 |   70.2% |
|   10000 |        735339 |               218264 |   70.3% |

## Key Takeaways

1. **Context window savings:** At 1,000+ entries, the typed index saves ~65% of context tokens.
2. **Crossover:** Below ~10 entries, the flat format is more compact.
3. **Tool call cost:** Even reading 10 topics per session, the typed index uses fewer total tokens at 100+ entries.
4. **Scalability:** At 10,000 entries, the flat format consumes 735,339 tokens — the typed index uses 216,734 (70.5% less).

## Methodology

- Synthetic entries generated with realistic titles (20 rotating topics) and bodies (~120 chars each).
- Token count approximated as ceil(chars / 4). Ratios are what matter, not absolute counts.
- Tool call overhead estimated at 80 tokens per invocation (request framing + result wrapper).
- Flat memory: all entries as bullet points in a single MEMORY.md file.
- Typed index: markdown table in MEMORY.md with topic content in separate files under memory/topics/.
- All measurements taken inside the NemoClaw sandbox container against real filesystem operations.
