import type {
  AgentOutput,
  AgentToolName,
  CheckResult,
  PromptItem,
  ToolRequirement,
} from "../types.js";
import { ALL_AGENT_TOOLS } from "../types.js";

/**
 * Tool-selection check.
 *
 * Asserts the agent picked the tool(s) listed in `expected_tools` for this
 * prompt. Each top-level entry must be satisfied — entries are AND-combined
 * — AND each referenced tool must be a member of the agent tool surface
 * (defensive — a misspelling in the prompt file would otherwise pass
 * silently, mirroring the kimi-eval sdk-fidelity check).
 *
 * A top-level entry can also be a nested array: that represents an
 * OR-group, satisfied if ANY one of those tools is present. Use OR-groups
 * when there's a legitimate ambiguity ("tonight's occupancy" can be
 * answered via `getOccupancyRate` OR `getReservations`).
 */
export function checkToolSelection(prompt: PromptItem, output: AgentOutput): CheckResult {
  const required: ToolRequirement[] = prompt.expected_tools ?? [];
  if (required.length === 0) {
    return { name: "tool-selection", passed: true, details: { skipped: "no tools required" } };
  }

  const approved = new Set<string>(ALL_AGENT_TOOLS as string[]);
  const calledNames = new Set<string>(output.toolCalls.map((c) => c.name));
  const missing: string[] = [];
  const unapproved: string[] = [];

  for (const entry of required) {
    if (Array.isArray(entry)) {
      const alternatives: AgentToolName[] = entry;
      const unapprovedInGroup = alternatives.filter((a) => !approved.has(a));
      for (const u of unapprovedInGroup) unapproved.push(u);
      const approvedAlternatives = alternatives.filter((a) => approved.has(a));
      const groupSatisfied = approvedAlternatives.some((a) => calledNames.has(a));
      if (!groupSatisfied && approvedAlternatives.length > 0) {
        missing.push(`(${alternatives.join(" | ")})`);
      }
      continue;
    }
    if (!approved.has(entry)) {
      unapproved.push(entry);
      continue;
    }
    if (!calledNames.has(entry)) missing.push(entry);
  }

  if (missing.length === 0 && unapproved.length === 0) {
    return {
      name: "tool-selection",
      passed: true,
      details: { required, called: [...calledNames] },
    };
  }
  return {
    name: "tool-selection",
    passed: false,
    reason: [
      missing.length ? `missing required tools: ${missing.join(", ")}` : null,
      unapproved.length ? `prompt requires unapproved tools: ${unapproved.join(", ")}` : null,
    ]
      .filter(Boolean)
      .join("; "),
    details: { required, called: [...calledNames], missing, unapproved },
  };
}
