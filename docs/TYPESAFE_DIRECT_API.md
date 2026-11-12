# Direct TypeSafe API for Jev

Emberpath can classify requests with TypeSafe's Jev decision model, either
directly through the TypeSafe API or through OpenRouter. This page documents the
direct integration: the public API it calls, the Router adapter, configuration,
and how to evaluate it.

## API details

| Item | Direct TypeSafe value |
| --- | --- |
| Method and endpoint | `POST https://api.typesafe.ai/v1/systemone` |
| Authentication | `Authorization: Bearer <your TypeSafe API key>` |
| Content type | `application/json` |
| Latest model alias | `jev-latest` |
| Pinned model example | `jev-1.13.0` |
| Request fields | `model`, `state`, `questions` |
| Response fields | `model`, `answers`, `usage` |

The request shape matches the typed decision interface used through
OpenRouter. Questions can be `choice`, `noul` (yes/no probability), or `score`.
Use direct model names, not OpenRouter's `~typesafe/jev-latest` or
`typesafe/jev-1.13` names. This is a decision API, not `/chat/completions`.

Minimal request body:

```json
{
  "model": "jev-latest",
  "state": "Write a TypeScript function to sort numbers.",
  "questions": {
    "is_coding": {
      "type": "noul",
      "instructions": "Does this request involve writing or debugging code?"
    }
  }
}
```

Read `answers.is_coding.noul` as a probability between 0 and 1. The Router
adapter instead sends the profile, injection, and NSFW questions in one request
and validates all three answers. The model identity returned by each provider
(for example `jev-1.13.0` directly, or a dated `typesafe/jev-1.13-YYYYMMDD`
through OpenRouter) is recorded as returned, not normalized.

Official sources: [HTTP API reference](https://docs.typesafe.ai/api),
[quick start](https://docs.typesafe.ai/introduction/quickstart),
[model names and aliases](https://docs.typesafe.ai/models).

## Router adapter

[`src/routing/typesafe.ts`](../src/routing/typesafe.ts)
provides `classifyTypeSafeDecision(state, { apiKey, model?, timeoutMs? })` with a
fixed HTTPS destination, redirect rejection, cancellation, bounded input/output,
and validated responses. It shares the decision rubric and response schema with
the OpenRouter transport. Provider error bodies are not logged, and the adapter
does not retry automatically, so rate limits and other failures stay visible.

## Configuration

| Variable | Purpose |
| --- | --- |
| `HIVE_TYPESAFE_AI_KEY` | TypeSafe API key for the direct transport |
| `HIVE_TYPESAFE_AI_MODEL` | Direct model name (default `jev-latest`) |
| `HIVE_ROUTER_OPENROUTER_KEY` | OpenRouter key for the fallback transport |
| `HIVE_ROUTER_DECISION_MODEL` | OpenRouter model (default `~typesafe/jev-latest`) |

On a deployed Router these belong in the service's private environment
(`/opt/hive-router/shared/.env`); restart `hive-router.service` after changing
them. The deploy script preserves that file and does not copy decision keys
from your workstation.

### Primary and fallback

Runtime classification prefers the direct TypeSafe transport when
`HIVE_TYPESAFE_AI_KEY` is set. A failed direct attempt falls back once to
OpenRouter when `HIVE_ROUTER_OPENROUTER_KEY` is set. Either provider can operate
alone, and no key is ever sent to the other provider. Valid answers never trigger
fallback, regardless of labels or confidence. Cancelled requests and oversized
inputs do not retry. The timeout applies per provider, so two attempts can take
up to twice the configured limit. If both providers fail the decision is recorded
as unavailable; no safe answer is fabricated.

Each trace records the selected transport, each attempt's sanitized status and
elapsed milliseconds, and the total decision duration. Decision mode `off`
disables calls; `shadow` records classifications while leaving alias, routing,
and blocking behaviour unchanged.

## Evaluating the integration

The evaluation and smoke scripts read keys from the process environment, falling
back to an untracked `.env` file at the repository root. Point
`HIVE_ROUTER_EVAL_ENV_FILE` at a different env file if you keep keys elsewhere.
Keys are never printed or written to output artifacts.

Run the decision evaluation against the direct transport from the repository root:

```bash
EVAL_PROVIDER=typesafe EVAL_LIMIT=3 \
  npm run eval:decisions

EVAL_PROVIDER=typesafe HIVE_TYPESAFE_AI_MODEL=jev-1.13.0 \
  EVAL_OUTPUT=/tmp/typesafe-evaluation.json \
  npm run eval:decisions
```

`EVAL_PROVIDER=typesafe` authenticates only with `HIVE_TYPESAFE_AI_KEY`; the
OpenRouter model variable does not affect direct model selection. The default
output file is `output/typesafe-decisions-eval.json` (git-ignored). Direct
responses report token usage without billing cost, so the summary cost is `null`
rather than zero. The evaluation exits nonzero when any case disagrees with its
expected labels; review those disagreements rather than relabelling fixtures.

Exercise the primary and fallback paths end to end with a synthetic prompt:

```bash
npm run smoke:jev
```

The smoke test calls the direct transport, then simulates a TypeSafe 503 locally
and confirms the OpenRouter fallback succeeds. It demonstrates the fallback path,
not provider availability.

Unit tests cover the endpoint, model and authentication format, unchanged
questions, error sanitization, malformed output, input/output limits, and
cancellation, and run without network access as part of
`npm test`. See
[ROUTING_CONTRACT.md](ROUTING_CONTRACT.md) for the offline
routing baseline and how to capture a new live candidate.
