import { describe, it, expect } from "vitest";
import {
  edgeTypeLabel,
  edgeAutoLabel,
  getImageSequenceNumber,
  edgeDisplayLabelById,
  stackHiddenStubs,
  hiddenStubOffset,
  hiddenStubGroup,
  hiddenStubRole,
  pluralTypeLabel,
  collapsedStubLabel,
  stubGroupKey,
} from "../labels";
import type { WorkflowEdge } from "@/types";

const edge = (id: string, overrides: Partial<WorkflowEdge> = {}): WorkflowEdge => ({
  id,
  source: "a",
  sourceHandle: "image",
  target: "b",
  targetHandle: "image",
  data: {},
  ...overrides,
});

describe("edgeTypeLabel", () => {
  it("names the data types", () => {
    expect(edgeTypeLabel("image-2")).toBe("Image");
    expect(edgeTypeLabel("prompt")).toBe("Text");
    expect(edgeTypeLabel("video")).toBe("Video");
    expect(edgeTypeLabel("audio")).toBe("Audio");
    expect(edgeTypeLabel("3d")).toBe("3D");
    expect(edgeTypeLabel("easeCurve")).toBe("Ease curve");
    expect(edgeTypeLabel(null)).toBe("Connection");
  });
});

describe("getImageSequenceNumber", () => {
  it("orders siblings by creation time", () => {
    const edges = [edge("late", { data: { createdAt: 20 } }), edge("early", { source: "c", data: { createdAt: 10 } })];
    expect(getImageSequenceNumber(edges[0], edges)).toBe(2);
    expect(getImageSequenceNumber(edges[1], edges)).toBe(1);
  });

  it("is null for lone or non-image connections", () => {
    const lone = edge("e1");
    expect(getImageSequenceNumber(lone, [lone])).toBeNull();
    const text = edge("t", { sourceHandle: "text", targetHandle: "text" });
    expect(getImageSequenceNumber(text, [text, edge("t2", { sourceHandle: "text", targetHandle: "text", source: "c" })])).toBeNull();
  });
});

describe("edgeAutoLabel", () => {
  it("uses the image order when several images feed one handle", () => {
    const edges = [edge("first", { data: { createdAt: 1 } }), edge("second", { source: "c", data: { createdAt: 2 } })];
    expect(edgeAutoLabel(edges[1], edges)).toBe("Image 2");
    expect(edgeDisplayLabelById("first", edges)).toBe("Image 1");
  });

  it("falls back to the type name", () => {
    const lone = edge("e", { sourceHandle: "text", targetHandle: "text" });
    expect(edgeAutoLabel(lone, [lone])).toBe("Text");
    expect(edgeDisplayLabelById("missing", [lone])).toBe("");
  });
});

describe("stackHiddenStubs", () => {
  const edges = [
    edge("img1", { data: { hidden: true, createdAt: 10 } }),
    edge("img2", { source: "c", data: { hidden: true, createdAt: 20 } }),
    edge("img3", { source: "d", data: { hidden: true, createdAt: 30 } }),
    edge("txt1", { source: "p", sourceHandle: "text", targetHandle: "text", data: { hidden: true, createdAt: 5 } }),
    edge("shown", { source: "e", data: { createdAt: 1 } }),
    edge("elsewhere", { source: "c", target: "z", data: { hidden: true, createdAt: 2 } }),
  ];
  const handleY = (handleId: string | null) => (handleId === "image" ? 100 : handleId === "text" ? 130 : undefined);

  const imageGroup = stubGroupKey("b", "target", "image");

  it("gives a handle with several hidden connections one row when collapsed", () => {
    const placed = stackHiddenStubs(edges, "b", "target", handleY);
    expect(placed.get("img1")).toBe(100);
    expect(placed.get("img2")).toBe(100);
    expect(placed.get("img3")).toBe(100);
    // The text handle at 130 is clear of the single image row
    expect(placed.get("txt1")).toBe(130);
  });

  it("pushes stubs down when the ones above them are too close", () => {
    const placed = stackHiddenStubs(edges, "b", "target", handleY, 0, imageGroup);
    expect(placed.get("img1")).toBe(100);
    expect(placed.get("img2")).toBe(122);
    expect(placed.get("img3")).toBe(144);
    // The text handle sits at 130 but the image stack runs past it; a new type gets extra room
    expect(placed.get("txt1")).toBe(174);
  });

  it("leaves a stub at its handle when there is room", () => {
    const roomy = (handleId: string | null) => (handleId === "image" ? 100 : 300);
    const placed = stackHiddenStubs(edges, "b", "target", roomy, 0, imageGroup);
    expect(placed.get("txt1")).toBe(300);
  });

  it("ignores visible edges and other nodes", () => {
    const placed = stackHiddenStubs(edges, "b", "target", handleY);
    expect(placed.has("shown")).toBe(false);
    expect(placed.has("elsewhere")).toBe(false);
  });

  it("stacks an Array item name with the stubs instead of under one", () => {
    // The expanded image stack runs to 144, past the text handle at 130
    const placed = stackHiddenStubs(edges, "b", "target", handleY, 0, imageGroup, [
      { edgeId: "item", handleId: "text", createdAt: 1 },
    ]);
    expect(placed.get("img3")).toBe(144);
    expect(placed.get("item")).toBe(174);
    // The hidden text stub on the same handle stacks below the name
    expect(placed.get("txt1")).toBe(196);
  });

  it("leaves an Array item name at its handle when nothing is near", () => {
    const placed = stackHiddenStubs([], "b", "target", handleY, 0, null, [{ edgeId: "item", handleId: "text", createdAt: 1 }]);
    expect(placed.get("item")).toBe(130);
  });

  it("orders by creation on the source side when handles are level", () => {
    const placed = stackHiddenStubs(edges, "c", "source", () => 50, 0, stubGroupKey("c", "source", "image"));
    expect(placed.get("elsewhere")).toBe(50);
    expect(placed.get("img2")).toBe(72);
  });
});

describe("hiddenStubOffset", () => {
  const edges = [
    edge("a1", { data: { hidden: true, createdAt: 1 } }),
    edge("a2", { source: "c", data: { hidden: true, createdAt: 2 } }),
    edge("t", { source: "p", sourceHandle: "text", targetHandle: "text", data: { hidden: true, createdAt: 3 } }),
  ];
  const handleY = (handleId: string | null) => (handleId === "image" ? 100 : 110);

  const expanded = stubGroupKey("b", "target", "image");

  it("is the distance a stub was pushed below its own handle", () => {
    expect(hiddenStubOffset("a1", edges, "target", handleY, 100, expanded)).toBe(0);
    expect(hiddenStubOffset("a2", edges, "target", handleY, 100, expanded)).toBe(22);
    // Rows at 100 and 122, then the group gap before the text stub
    expect(hiddenStubOffset("t", edges, "target", handleY, 110, expanded)).toBe(42);
  });

  it("keeps collapsed members level with their handle", () => {
    expect(hiddenStubOffset("a2", edges, "target", handleY, 100)).toBe(0);
    expect(hiddenStubOffset("t", edges, "target", handleY, 110)).toBe(20);
  });

  it("falls back to the caller's y when handle positions are unknown", () => {
    expect(hiddenStubOffset("a2", edges, "target", () => undefined, 100, expanded)).toBe(22);
  });

  it("is zero for unknown edges", () => {
    expect(hiddenStubOffset("nope", edges, "target", handleY, 0)).toBe(0);
  });
});

describe("edgeDisplayLabel", () => {
  it("prefers the user's own label, trimmed", async () => {
    const { edgeDisplayLabel, edgeDisplayLabelById } = await import("../labels");
    const own = edge("own", { data: { label: "  hero shot " } });
    expect(edgeDisplayLabel(own, [own])).toBe("hero shot");
    expect(edgeDisplayLabelById("own", [own])).toBe("hero shot");
  });

  it("falls back to the automatic label when the own label is blank", async () => {
    const { edgeDisplayLabel } = await import("../labels");
    const blank = edge("blank", { data: { label: "   " } });
    expect(edgeDisplayLabel(blank, [blank])).toBe("Image");
  });
});

describe("parallelEdgePosition", () => {
  it("orders visible edges between the same nodes by creation time", async () => {
    const { parallelEdgePosition } = await import("../labels");
    const edges = [
      edge("second", { targetHandle: "image-1", data: { createdAt: 2 } }),
      edge("first", { data: { createdAt: 1 } }),
      edge("hidden", { targetHandle: "image-2", data: { createdAt: 0, hidden: true } }),
      edge("other", { target: "z", data: { createdAt: 3 } }),
    ];
    expect(parallelEdgePosition("first", edges)).toEqual({ index: 0, count: 2 });
    expect(parallelEdgePosition("second", edges)).toEqual({ index: 1, count: 2 });
    expect(parallelEdgePosition("other", edges)).toEqual({ index: 0, count: 1 });
    expect(parallelEdgePosition("missing", edges)).toEqual({ index: 0, count: 1 });
  });
});

describe("hidden stub groups", () => {
  const edges = [
    edge("a1", { data: { hidden: true, createdAt: 2 } }),
    edge("a2", { source: "c", data: { hidden: true, createdAt: 1 } }),
    edge("t", { source: "p", sourceHandle: "text", targetHandle: "text", data: { hidden: true, createdAt: 3 } }),
    edge("shown", { source: "d", data: {} }),
  ];
  const key = stubGroupKey("b", "target", "image");

  it("groups the hidden connections on one handle in creation order", () => {
    expect(hiddenStubGroup("a1", edges, "target")).toEqual({ key, members: ["a2", "a1"] });
    expect(hiddenStubGroup("a1", edges, "source")).toEqual({ key: stubGroupKey("a", "source", "image"), members: ["a1"] });
    expect(hiddenStubGroup("shown", edges, "target")).toBeNull();
    expect(hiddenStubGroup("nope", edges, "target")).toBeNull();
  });

  it("makes the first member the leader of a collapsed group", () => {
    expect(hiddenStubRole("a2", edges, "target", null)).toBe("collapsed-leader");
    expect(hiddenStubRole("a1", edges, "target", null)).toBe("collapsed-member");
    expect(hiddenStubRole("a1", edges, "target", key)).toBe("expanded");
    expect(hiddenStubRole("t", edges, "target", null)).toBe("single");
    expect(hiddenStubRole("a1", edges, "source", null)).toBe("single");
  });

  it("keeps a named connection outside its handle's group", () => {
    const named = [
      ...edges,
      edge("hero", { source: "h", data: { hidden: true, createdAt: 0, label: "Important" } }),
    ];
    expect(hiddenStubGroup("hero", named, "target")).toEqual({
      key: `${key}#Important`,
      members: ["hero"],
      label: "Important",
    });
    expect(hiddenStubGroup("a1", named, "target")?.members).toEqual(["a2", "a1"]);
    expect(hiddenStubRole("hero", named, "target", null)).toBe("single");
    expect(hiddenStubRole("a2", named, "target", null)).toBe("collapsed-leader");
    // The shared pill comes first, then the named one, even though it was made earlier
    const placed = stackHiddenStubs(named, "b", "target", () => 100);
    expect(placed.get("a2")).toBe(100);
    expect(placed.get("hero")).toBe(122);
    // The text handle's stub follows, after the group gap
    expect(placed.get("t")).toBe(152);
  });

  it("stacks the connections at one handle that share a label", () => {
    const model = [
      ...edges,
      edge("m1", { source: "m", data: { hidden: true, createdAt: 4, label: "Model" } }),
      edge("m2", { source: "n", data: { hidden: true, createdAt: 5, label: " Model " } }),
      edge("other", { source: "o", data: { hidden: true, createdAt: 6, label: "Style" } }),
    ];
    const modelKey = stubGroupKey("b", "target", "image", "Model");
    expect(modelKey).toBe(`${key}#Model`);
    expect(hiddenStubGroup("m2", model, "target")).toEqual({ key: modelKey, members: ["m1", "m2"], label: "Model" });
    // The unnamed ones keep their own stack, and another name is another stack
    expect(hiddenStubGroup("a1", model, "target")?.members).toEqual(["a2", "a1"]);
    expect(hiddenStubGroup("other", model, "target")?.members).toEqual(["other"]);
    expect(hiddenStubRole("m1", model, "target", null)).toBe("collapsed-leader");
    expect(hiddenStubRole("m2", model, "target", null)).toBe("collapsed-member");
    expect(hiddenStubRole("m2", model, "target", modelKey)).toBe("expanded");
    // Each source still has its own pill
    expect(hiddenStubRole("m1", model, "source", null)).toBe("single");
    // Unnamed stack, then the named ones by age, then the text handle
    const placed = stackHiddenStubs(model, "b", "target", () => 100);
    expect(placed.get("a2")).toBe(100);
    expect(placed.get("m1")).toBe(122);
    expect(placed.get("m2")).toBe(122);
    expect(placed.get("other")).toBe(144);
    expect(placed.get("t")).toBe(174);
  });

  it("moves a renamed member into the stack of its new name", () => {
    const model = [
      edge("m1", { source: "m", data: { hidden: true, createdAt: 1, label: "Model" } }),
      edge("m2", { source: "n", data: { hidden: true, createdAt: 2, label: "Model" } }),
      edge("m3", { source: "o", data: { hidden: true, createdAt: 3, label: "Model" } }),
    ];
    const renamed = model.map((e) => (e.id === "m2" ? { ...e, data: { ...e.data, label: "Base" } } : e));
    expect(hiddenStubGroup("m1", renamed, "target")?.members).toEqual(["m1", "m3"]);
    expect(hiddenStubGroup("m2", renamed, "target")).toMatchObject({ key: stubGroupKey("b", "target", "image", "Base"), members: ["m2"] });
  });

  it("labels a collapsed pill with its stack's name, else the plural type", () => {
    expect(collapsedStubLabel("Model", "text")).toBe("Model");
    expect(collapsedStubLabel("  ", "text")).toBe("Texts");
    expect(collapsedStubLabel(undefined, "image")).toBe("Images");
  });

  it("pluralises the type label, except where the word has no plural", () => {
    expect(pluralTypeLabel("image")).toBe("Images");
    expect(pluralTypeLabel("text")).toBe("Texts");
    expect(pluralTypeLabel("audio")).toBe("Audio");
    expect(pluralTypeLabel("3d")).toBe("3D");
  });
});

describe("edgeTypeLabel for the split grid link", () => {
  it("names a reference connection after the split that made it", () => {
    expect(edgeTypeLabel("reference")).toBe("Split");
    expect(pluralTypeLabel("reference")).toBe("Splits");
  });
});
