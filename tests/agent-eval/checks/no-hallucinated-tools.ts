import type { AgentOutput, CheckResult } from "../types.js";
import { ALL_AGENT_TOOLS } from "../types.js";

/**
 * No-hallucinated-tools check.
 *
 * The agent's tool surface is a closed set (the 7 tools exported by
 * `repullAgentTools` in `@repull/ai-sdk/agent`). Any tool name in
 * `output.toolCalls` that is NOT in the allowlist is a hallucination —
 * either the model invented a tool that doesn't exist, or there's a
 * deployment-side instrumentation bug.
 *
 * This is the agent twin of kimi-eval's `no-hallucination` check (which
 * scans for invented `repull.*` SDK identifiers in generated code).
 */
export function checkNoHallucinatedTools(output: AgentOutput): CheckResult {
  const approved = new Set<string>(ALL_AGENT_TOOLS as string[]);
  const unknown: string[] = [];
  for (const call of output.toolCalls) {
    if (!approved.has(call.name)) unknown.push(call.name);
  }
  if (unknown.length === 0) {
    return {
      name: "no-hallucinated-tools",
      passed: true,
      details: { called: output.toolCalls.map((c) => c.name) },
    };
  }
  return {
    name: "no-hallucinated-tools",
    passed: false,
    reason: `agent called tools not in the surface: ${unknown.join(", ")}`,
    details: { unknown, approved: [...approved] },
  };
}
