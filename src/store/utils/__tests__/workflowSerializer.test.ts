import { describe, it, expect } from "vitest";
import { serializeWorkflowRequest } from "../workflowSerializer";
import type { WorkflowFile } from "@/store/workflowStore";

function workflow(overrides: Partial<WorkflowFile> = {}): WorkflowFile {
  return {
    version: 1,
    id: "wf",
    name: "Cars \"quoted\" ✓",
    directoryPath: "/tmp/x",
    nodes: [
      { id: "a", type: "prompt", position: { x: 0, y: 0 }, data: { prompt: "a fox\n\u0000", skip: undefined } },
      { id: "b", type: "nanoBanana", position: { x: 1, y: 2 }, data: { outputImage: null, list: [1, undefined, "x"] } },
    ],
    edges: [{ id: "e", source: "a", target: "b", sourceHandle: "text", targetHandle: "text" }],
    edgeStyle: "angular",
    groups: undefined,
    ...overrides,
  } as WorkflowFile;
}

describe("serializeWorkflowRequest", () => {
  it("gives what JSON.stringify gives", () => {
    const meta = { directoryPath: "/tmp/x", filename: "Cars" };
    const wf = workflow();
    expect(serializeWorkflowRequest(meta, wf)).toBe(JSON.stringify({ ...meta, workflow: wf }));
  });

  it("handles empty lists and edges before nodes", () => {
    const meta = { filename: "x" };
    const wf = { edges: [], version: 1, nodes: [], name: "x" } as unknown as WorkflowFile;
    expect(serializeWorkflowRequest(meta, wf)).toBe(JSON.stringify({ ...meta, workflow: wf }));
  });

  it("reuses an unchanged node's JSON and redoes a replaced one", () => {
    const meta = { filename: "x" };
    const wf = workflow();
    serializeWorkflowRequest(meta, wf);
    const edited = { ...wf, nodes: [{ ...wf.nodes[0], data: { prompt: "a cat" } }, wf.nodes[1]] } as WorkflowFile;
    const text = serializeWorkflowRequest(meta, edited);
    expect(text).toBe(JSON.stringify({ ...meta, workflow: edited }));
    expect(text).toContain("a cat");
  });
});
