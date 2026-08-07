# Example incident trace

> **Synthetic fixture — not live acceptance evidence.** This complete JSONL trace was generated on 2026-07-26 by the current agent loop against `test/fixtures/agent-crash-result.json` with a scripted provider. The cluster, Anthropic API, and Telegram were not contacted. `fixture-*` identifiers, timestamps, and token counts are deterministic test data, not measured production values. Replace this trace after the live T5 demo.

## What the trace retains

Production writes one append-only JSONL file for each `(incidentFingerprint, runId)` pair under `TRACE_DIR` (`./traces` by default). When the directory is missing, the sink creates it with mode `0700`; an existing directory or mounted volume keeps its current mode, so operators must enforce equivalent access there. Each trace file is opened with mode `0600`, and its filename is a SHA-256 digest rather than an operator-controlled path.

The trace is deliberately evidence-oriented:

- `provider_request.inputTokens` is the preflight context count used to enforce the budget. It is not a billing record.
- `provider_response` carries the provider-reported usage fields used for cost calculation.
- `tool_call.input` retains only the citation-relevant, allowlisted arguments for the five read-only tools.
- `tool_result` retains byte counts, a SHA-256 digest, and truncation/summarization metadata—not the raw Kubernetes, Prometheus, or log payload.
- `report_completed.report` retains the validated cited report so an operator can connect each claim to a code-issued `call_###` evidence ID. Suggestions remain marked `executed: false`.

Before disk write, sensitive keys and recognizable credentials are replaced with `[REDACTED]`. This covers API keys, authorization and cookie headers, passwords, secrets, tokens, credential-like keys, and credentials embedded in URLs or text. Opaque provider state and hidden reasoning/thinking fields are never copied into the trace event schema. This protects against accidental retention, but operators must still treat traces as sensitive incident data and apply normal retention and access controls.

## Complete synthetic CrashLoopBackOff trace

This is the whole successful fixture run: incident admission, four model turns, three bounded read-only tool calls, and the final cited report. A successful run does not emit `run_stopped`; that event is reserved for context/tool limits, provider refusal/error, or invalid reports.

```jsonl
{"timestamp":"2026-07-26T09:10:11.000Z","type":"incident_started","incidentFingerprint":"f17a5e4d930bc245","runId":"fixture-run-001","startsAt":"2026-07-26T08:55:00Z","alertname":"KubePodContainerRestarting","namespace":"payments","pod":"checkout-7bd9","severity":"critical"}
{"timestamp":"2026-07-26T09:10:11.025Z","type":"provider_request","incidentFingerprint":"f17a5e4d930bc245","runId":"fixture-run-001","provider":"fixture-scripted","requestId":"request_001","inputTokens":100,"messageCount":1,"toolDefinitionCount":5,"remainingToolCalls":10}
{"timestamp":"2026-07-26T09:10:11.050Z","type":"provider_response","incidentFingerprint":"f17a5e4d930bc245","runId":"fixture-run-001","provider":"fixture-scripted","requestId":"request_001","responseId":"fixture_response_1","model":"fixture-model","stopReason":"tool_use","inputTokens":101,"cacheCreationInputTokens":0,"cacheReadInputTokens":0,"outputTokens":20,"toolCallCount":1}
{"timestamp":"2026-07-26T09:10:11.075Z","type":"tool_call","incidentFingerprint":"f17a5e4d930bc245","runId":"fixture-run-001","callId":"call_001","toolName":"get_rollout_history","input":{"deployment":"checkout","namespace":"payments"},"providerToolCallId":"fixture_tool_1"}
{"timestamp":"2026-07-26T09:10:11.100Z","type":"tool_result","incidentFingerprint":"f17a5e4d930bc245","runId":"fixture-run-001","callId":"call_001","toolName":"get_rollout_history","rawBytes":640,"admittedBytes":726,"contentSha256":"6f11258c52077717edb4ff085ebad79378a92927351b80e14593ae690b93b377","truncated":false,"truncationReasons":[],"summarized":false,"providerToolCallId":"fixture_tool_1"}
{"timestamp":"2026-07-26T09:10:11.125Z","type":"provider_request","incidentFingerprint":"f17a5e4d930bc245","runId":"fixture-run-001","provider":"fixture-scripted","requestId":"request_002","inputTokens":100,"messageCount":3,"toolDefinitionCount":5,"remainingToolCalls":9}
{"timestamp":"2026-07-26T09:10:11.150Z","type":"provider_response","incidentFingerprint":"f17a5e4d930bc245","runId":"fixture-run-001","provider":"fixture-scripted","requestId":"request_002","responseId":"fixture_response_2","model":"fixture-model","stopReason":"tool_use","inputTokens":102,"cacheCreationInputTokens":0,"cacheReadInputTokens":0,"outputTokens":20,"toolCallCount":1}
{"timestamp":"2026-07-26T09:10:11.175Z","type":"tool_call","incidentFingerprint":"f17a5e4d930bc245","runId":"fixture-run-001","callId":"call_002","toolName":"kubectl_describe","input":{"kind":"pod","name":"checkout-7bd9","namespace":"payments"},"providerToolCallId":"fixture_tool_2"}
{"timestamp":"2026-07-26T09:10:11.200Z","type":"tool_result","incidentFingerprint":"f17a5e4d930bc245","runId":"fixture-run-001","callId":"call_002","toolName":"kubectl_describe","rawBytes":250,"admittedBytes":333,"contentSha256":"25db39f32a8dc28603d086eb28787ad89a4366464bffb96a04f180f57a4aa9bf","truncated":false,"truncationReasons":[],"summarized":false,"providerToolCallId":"fixture_tool_2"}
{"timestamp":"2026-07-26T09:10:11.225Z","type":"provider_request","incidentFingerprint":"f17a5e4d930bc245","runId":"fixture-run-001","provider":"fixture-scripted","requestId":"request_003","inputTokens":100,"messageCount":5,"toolDefinitionCount":5,"remainingToolCalls":8}
{"timestamp":"2026-07-26T09:10:11.250Z","type":"provider_response","incidentFingerprint":"f17a5e4d930bc245","runId":"fixture-run-001","provider":"fixture-scripted","requestId":"request_003","responseId":"fixture_response_3","model":"fixture-model","stopReason":"tool_use","inputTokens":103,"cacheCreationInputTokens":0,"cacheReadInputTokens":0,"outputTokens":20,"toolCallCount":1}
{"timestamp":"2026-07-26T09:10:11.275Z","type":"tool_call","incidentFingerprint":"f17a5e4d930bc245","runId":"fixture-run-001","callId":"call_003","toolName":"get_pod_logs","input":{"namespace":"payments","pod":"checkout-7bd9","container":"checkout","lines":50},"providerToolCallId":"fixture_tool_3"}
{"timestamp":"2026-07-26T09:10:11.300Z","type":"tool_result","incidentFingerprint":"f17a5e4d930bc245","runId":"fixture-run-001","callId":"call_003","toolName":"get_pod_logs","rawBytes":304,"admittedBytes":383,"contentSha256":"239a2215e471235517e36e98fe30ad8e364bd496be6dcc2d0b2df032f1b66118","truncated":false,"truncationReasons":[],"summarized":false,"providerToolCallId":"fixture_tool_3"}
{"timestamp":"2026-07-26T09:10:11.325Z","type":"provider_request","incidentFingerprint":"f17a5e4d930bc245","runId":"fixture-run-001","provider":"fixture-scripted","requestId":"request_004","inputTokens":100,"messageCount":7,"toolDefinitionCount":5,"remainingToolCalls":7}
{"timestamp":"2026-07-26T09:10:11.350Z","type":"provider_response","incidentFingerprint":"f17a5e4d930bc245","runId":"fixture-run-001","provider":"fixture-scripted","requestId":"request_004","responseId":"fixture_response_4","model":"fixture-model","stopReason":"end_turn","inputTokens":104,"cacheCreationInputTokens":0,"cacheReadInputTokens":0,"outputTokens":20,"toolCallCount":0}
{"timestamp":"2026-07-26T09:10:11.375Z","type":"report_completed","incidentFingerprint":"f17a5e4d930bc245","runId":"fixture-run-001","status":"diagnosed","toolCallCount":3,"citationCount":3,"reportBytes":958,"report":{"status":"diagnosed","probableCause":{"claim":"The latest checkout image is broken and is causing CrashLoopBackOff.","confidence":"high","evidenceCallIds":["call_001","call_002","call_003"]},"evidence":[{"callId":"call_001","observation":"Revision 18 introduced the v2-broken image and has no ready replicas."},{"callId":"call_002","observation":"The checkout pod is in CrashLoopBackOff after exiting with code 127."},{"callId":"call_003","observation":"The bounded log tail says the new image cannot find /app/server."}],"suggestions":[{"action":"Have an operator roll back to the last known-good image.","rationale":"The cited read-only evidence supports this operator suggestion.","evidenceCallIds":["call_001","call_002","call_003"],"executed":false}],"recentChanges":[{"change":"Deployment revision 18 changed the image to registry.example/checkout:v2-broken.","evidenceCallIds":["call_001"]}],"uncertainties":["No application profile was available."]}}
```

## Cost per incident

The configured default production model is `claude-sonnet-5`. On **2026-07-26**, Anthropic's first-party Claude API introductory rate is **$2 per million base input tokens** and **$10 per million output tokens** through 2026-08-31. Anthropic lists the standard rate from 2026-09-01 as $3/$15 per million input/output tokens. Source checked 2026-07-26: [Anthropic Claude pricing](https://platform.claude.com/docs/en/about-claude/pricing). The official model ID is also documented by [Anthropic's Sonnet 5 model notes](https://platform.claude.com/docs/en/about-claude/models/whats-new-sonnet-5).

For the current implementation, calculate one incident from its `provider_response` events only:

```text
I = sum(provider_response.inputTokens)
O = sum(provider_response.outputTokens)

cost_usd_as_of_2026_07_26 = (I × 2 + O × 10) / 1,000,000
```

Do **not** add `provider_request.inputTokens`; those are preflight counts and would double-count model input. Anthropic prices client-side tool use through the request's input and output token usage, so do not add a separate per-tool fee. The current provider does not enable prompt caching, which is why its cache counters should be zero.

> **Illustrative calculator example—not measured usage and not the synthetic trace above.** If a future live incident's provider responses total exactly 12,000 base input tokens and 1,000 output tokens, with zero cache tokens, the introductory-rate estimate would be `(12,000 × $2 + 1,000 × $10) / 1,000,000 = $0.034`.

Anthropic currently lists 5-minute cache writes at 1.25× the base input rate, 1-hour writes at 2×, and cache reads at 0.1×. If prompt caching is added later, the trace schema must distinguish the cache-write TTL (or the deployment configuration must make it unambiguous) before `cacheCreationInputTokens` can produce an exact cost. Also refresh this section whenever the model, inference geography, billing platform, or effective pricing date changes; US-only first-party inference carries a 1.1× multiplier, and partner-cloud pricing can differ.

## Live-demo replacement checklist

After T4/T5 live-cluster acceptance, replace the synthetic block above with one sanitized trace from the real alert run and update the status banner. Before publishing:

1. Confirm `provider` is `anthropic`, `model` is the deployed model, and every event shares the real incident fingerprint and run ID.
2. Confirm the report's `call_###` citations resolve to preceding `tool_call`/`tool_result` pairs and that all suggestions remain `executed: false`.
3. Sum only the real `provider_response` usage values, label the result as measured, and calculate it using pricing rechecked on the demo date.
4. Re-run the secret/redaction review. Do not publish raw tool output, credentials, cookies, authorization headers, opaque provider state, hidden reasoning, or unredacted incident data.
5. Link the corresponding Telegram screenshot/GIF only after confirming it came from the same live run.
