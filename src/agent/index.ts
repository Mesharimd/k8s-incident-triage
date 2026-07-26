import type { Incident } from "../incident";
import { createProductionReadOnlyToolRegistry } from "../tools";
import { JsonlTraceSink } from "../trace";
import { AnthropicProvider } from "./anthropic";
import {
  runTriageAgent,
  type TriageRunOptions,
  type TriageRunResult,
} from "./loop";
import { loadAgentRuntimeConfig } from "./provider";

export interface ProductionTriageAgent {
  triage(
    incident: Incident,
    options?: TriageRunOptions,
  ): Promise<TriageRunResult>;
}

export function createProductionTriageAgent(
  environment: Readonly<Record<string, string | undefined>> = Bun.env,
): ProductionTriageAgent {
  const provider = new AnthropicProvider({ environment });
  const tools = createProductionReadOnlyToolRegistry(environment);
  const traceDirectory = environment.TRACE_DIR?.trim() || "./traces";
  const trace = new JsonlTraceSink({ directory: traceDirectory });
  const config = loadAgentRuntimeConfig(environment);

  return {
    triage: (incident, options) =>
      runTriageAgent(
        incident,
        {
          provider,
          tools,
          trace,
          config,
        },
        options,
      ),
  };
}

export type { TriageRunResult } from "./loop";
export type { TriageReport } from "./triage-report";
