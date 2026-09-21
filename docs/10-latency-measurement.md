# Latency: what was measured, and how to measure it again

> **Prepared for the final documentation pass. Not yet reviewer-facing.**
> `README.md` and `/review` are unchanged until acceptance.

## What these numbers are, and are not

They are **small-sample browser observations**, taken by hand against the
deployed application from one machine on one network.

They are **not** an SLA, **not** a load test, **not** a concurrency result,
and **not** a statement about other regions, weak networks or cold starts.
At n=12 a p95 is simply the slowest run observed; it is reported as a
percentile because that is what the arithmetic is, not because twelve
samples support a tail claim.

One term is worth being exact about, because it is the one most often
overclaimed:

> **"First response chunk"** is the moment the first byte of the NDJSON
> stream reaches the browser's reader. It is **not** model
> time-to-first-token. Between the model's first token and that byte sit
> the provider's own buffering, the serverless function's response start,
> and the network. Calling it TTFT would attribute all of that to the
> model.

## The recorded observations

| Path | Sample | p50 | p95 |
|---|---:|---:|---:|
| Chat — first response chunk | n=12 | 2.0 s | 4.5 s |
| Chat — complete turn | n=12 | 3.1 s | 7.9 s |
| Voice transcription — fixed 7.9 s audio sample | n=12 | 3.0 s | 4.9 s |

Environment: deployed Vercel application, **warm** (a discarded warm-up
request first), requests issued one at a time from a single browser on the
deployed origin, no request failed. Percentiles are nearest-rank.

The slowest chat sample (7.9 s) also triggered a reconnect offer, so it did
additional work beyond an ordinary turn. It is **retained, not excluded** —
dropping the slow run because it was busy is how a latency table stops
describing the product.

## Repeating it

Each timer is defined by a browser-observable event, so a reviewer can
reproduce the numbers without instrumenting the server.

| | Timer starts | Timer ends |
|---|---|---|
| Chat — first response chunk | `fetch("/api/chat")` is called | the reader yields its first non-empty chunk |
| Chat — complete turn | same | the reader reports `done` |
| Voice transcription | `fetch("/api/voice/transcribe")` is called | the response body has been read |

Paste this into the browser console on the deployed origin, with a
conversation already open. It measures the real endpoints through the real
session cookie, and it prints nothing but timings.

```js
// Chat. Warm-up first, then n samples, one at a time.
async function chatSample(text) {
  const started = performance.now();
  const response = await fetch("/api/chat", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ text }),
  });
  const reader = response.body.getReader();
  let first = null;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (first === null && value?.length) first = performance.now() - started;
  }
  return { firstChunkMs: Math.round(first), completeMs: Math.round(performance.now() - started) };
}

async function run(n = 12) {
  await chatSample("warm up");                 // discarded
  const rows = [];
  for (let i = 0; i < n; i += 1) rows.push(await chatSample("How has your week been?"));
  const pick = (key, p) => {
    const sorted = rows.map((r) => r[key]).sort((a, b) => a - b);
    return sorted[Math.ceil((p / 100) * sorted.length) - 1];   // nearest-rank
  };
  console.table({
    firstChunk: { p50: pick("firstChunkMs", 50), p95: pick("firstChunkMs", 95) },
    complete: { p50: pick("completeMs", 50), p95: pick("completeMs", 95) },
    n: { p50: rows.length, p95: rows.length },
  });
}
run();
```

Transcription is measured the same way against `/api/voice/transcribe`,
posting **one fixed audio file** every time — the duration of the clip is
the dominant term, so a table that varied it would be measuring the clip
rather than the endpoint. The recorded row used a 7.9 s sample.

Each run must state: date, sample size, warm or cold, the audio duration
for the transcription row, and the network. A number without those is not
a measurement.

## What is deliberately not instrumented

Server-side spans, provider-reported token timings, and a metrics backend
would all give better numbers, and all of them mean vendor infrastructure
this POC has chosen not to add. The honest position is a reproducible
browser recipe and a short table, clearly labelled.

A production evaluation would separately track transcription latency,
model time-to-first-token (from the provider, not inferred), turn
completion, TTS start time, failure rate and provider usage — under
concurrency, from more than one region, and with cold starts included.
