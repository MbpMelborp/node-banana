import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useWorkflowStore, type WorkflowFile } from "../workflowStore";
import { externalizeWorkflowMedia, hydrateWorkflowMedia } from "@/utils/mediaStorage";
import type { WorkflowNode } from "@/types";
import { workflowImageReference } from "@/lib/media/references";

vi.mock("@/utils/mediaStorage", () => ({
  externalizeWorkflowMedia: vi.fn(async (workflow) => workflow),
  hydrateWorkflowMedia: vi.fn(async (workflow) => workflow),
}));
vi.mock("@/components/Toast", () => ({ useToast: { getState: () => ({ show: vi.fn() }) } }));

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

const node = (id: string, data: Record<string, unknown>, type = "imageInput"): WorkflowNode =>
  ({ id, type, data, position: { x: 0, y: 0 } }) as WorkflowNode;
const store = () => useWorkflowStore.getState();

beforeEach(() => {
  vi.clearAllMocks();
  store().clearClipboard();
  vi.mocked(externalizeWorkflowMedia).mockImplementation(async (workflow) => workflow);
  vi.mocked(hydrateWorkflowMedia).mockImplementation(async (workflow) => workflow);
  store().clearWorkflow();
  useWorkflowStore.setState({
    isSaving: false,
    pendingMediaSaves: 0,
    workflowId: "original-id",
    workflowName: "Original",
    saveDirectoryPath: "/project",
    useExternalImageStorage: true,
    imageRefBasePath: "/project",
  });
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ json: async () => ({ success: true }) }));
});

afterEach(() => {
  store().clearWorkflow();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("media copied between workflows", () => {
  it("is written into the destination's folder instead of keeping the source's file refs", async () => {
    useWorkflowStore.setState({
      nodes: [{ ...node("image-1", { image: "data:image/png;base64,copied", imageRef: "source-only" }), selected: true }],
      imageRefBasePath: "/source",
    });
    store().copySelectedNodes();
    store().newTab();
    useWorkflowStore.setState({
      imageRefBasePath: "/destination",
      saveDirectoryPath: "/destination",
      workflowName: "Destination",
      workflowId: "destination-id",
    });
    store().pasteNodes();
    await store().saveToFile();
    const saved = vi.mocked(externalizeWorkflowMedia).mock.calls[0][0];
    expect(saved.nodes[0].data.image).toBe("data:image/png;base64,copied");
    expect(saved.nodes[0].data.imageRef).toBeUndefined();
    // The source tab keeps its own ref
    expect(store().tabs[0].snapshot?.nodes[0].data.imageRef).toBe("source-only");
  });

  it("keeps its file refs when pasted back into the same folder", () => {
    useWorkflowStore.setState({
      nodes: [{ ...node("image-1", { image: "data:image/png;base64,copied", imageRef: "here" }), selected: true }],
      imageRefBasePath: "/project",
    });
    store().copySelectedNodes();
    store().pasteNodes();
    expect(store().nodes[1].data.imageRef).toBe("here");
  });

  it.each(["active", "parked"] as const)("survives closing its %s source tab", (which) => {
    const revoke = vi.spyOn(URL, "revokeObjectURL");
    useWorkflowStore.setState({ nodes: [{ ...node("video-1", { outputVideo: "blob:shared" }, "videoTrim"), selected: true }] });
    const sourceTab = store().activeTabId;
    store().copySelectedNodes();
    const targetTab = store().newTab()!;
    store().pasteNodes();
    store().clearClipboard();
    if (which === "active") store().switchTab(sourceTab);
    store().closeTab(sourceTab);
    expect(revoke).not.toHaveBeenCalledWith("blob:shared");
    expect(store().activeTabId).toBe(targetTab);
    expect(store().nodes[0].data.outputVideo).toBe("blob:shared");
    // Its last owner gone, it is released
    store().clearWorkflow();
    expect(revoke).toHaveBeenCalledWith("blob:shared");
  });

  it("survives clearing its source while it is still on the clipboard", () => {
    const revoke = vi.spyOn(URL, "revokeObjectURL");
    useWorkflowStore.setState({ nodes: [{ ...node("video-1", { outputVideo: "blob:clipboard" }, "videoTrim"), selected: true }] });
    store().copySelectedNodes();
    store().clearWorkflow();
    expect(revoke).not.toHaveBeenCalledWith("blob:clipboard");
    store().pasteNodes();
    expect(store().nodes[0].data.outputVideo).toBe("blob:clipboard");
    store().clearClipboard();
    store().clearWorkflow();
    expect(revoke).toHaveBeenCalledWith("blob:clipboard");
  });
});

describe("refs from a save that media changed under", () => {
  it.each([
    ["imageInput", "image", "imageRef", "data:image/png;base64,old", "data:image/png;base64,new", "old-image"],
    ["audioInput", "audioFile", "audioFileRef", "data:audio/wav;base64,old", "data:audio/wav;base64,new", "old-audio"],
    ["videoInput", "video", "videoRef", "data:video/mp4;base64,old", "data:video/mp4;base64,new", "old-video"],
    ["outputGallery", "images", "imageRefs", ["old"], ["new"], ["old-ref"]],
  ])("are not put on %s media replaced during the save", async (type, field, refField, oldMedia, newMedia, oldRef) => {
    const pending = deferred<WorkflowFile>();
    const original = node("media-1", { [field as string]: oldMedia }, type as string);
    useWorkflowStore.setState({ nodes: [original] });
    vi.mocked(externalizeWorkflowMedia).mockReturnValueOnce(pending.promise);

    const saving = store().saveToFile();
    await vi.waitFor(() => expect(externalizeWorkflowMedia).toHaveBeenCalledOnce());
    store().updateNodeData(original.id, { [field as string]: newMedia });
    pending.resolve({
      ...vi.mocked(externalizeWorkflowMedia).mock.calls[0][0],
      nodes: [node(original.id, { [field as string]: null, [refField as string]: oldRef }, type as string)],
    });
    expect(await saving).toBe(true);
    expect(store().nodes[0].data[field as string]).toEqual(newMedia);
    expect(store().nodes[0].data[refField as string]).toBeUndefined();
    expect(store().hasUnsavedChanges).toBe(true);

    // The next save writes the replacement rather than pointing at the old file
    await store().saveToFile();
    const nextSave = vi.mocked(externalizeWorkflowMedia).mock.calls[1][0];
    expect(nextSave.nodes[0].data[field as string]).toEqual(newMedia);
    expect(nextSave.nodes[0].data[refField as string]).toBeUndefined();
  });

  it("are still kept when only another field changed", async () => {
    const pending = deferred<WorkflowFile>();
    useWorkflowStore.setState({ nodes: [node("media-1", { image: "original" })] });
    vi.mocked(externalizeWorkflowMedia).mockReturnValueOnce(pending.promise);
    const saving = store().saveToFile();
    await vi.waitFor(() => expect(externalizeWorkflowMedia).toHaveBeenCalledOnce());
    store().updateNodeData("media-1", { label: "Renamed" });
    pending.resolve({
      ...vi.mocked(externalizeWorkflowMedia).mock.calls[0][0],
      nodes: [node("media-1", { image: null, imageRef: "saved-image" })],
    });
    await saving;
    expect(store().nodes[0].data).toMatchObject({ image: "original", imageRef: "saved-image", label: "Renamed" });
    expect(store().hasUnsavedChanges).toBe(true);
  });
});

describe("a canvas replaced while a load or save is in flight", () => {
  const file = (name: string): WorkflowFile => ({
    version: 1,
    name,
    nodes: [node(`${name}-node`, { image: name })],
    edges: [],
    edgeStyle: "angular",
  });

  it("is not overwritten when a slow load into another tab finishes", async () => {
    useWorkflowStore.setState({ nodes: [node("keep-me", { image: "unsaved" })], hasUnsavedChanges: true });
    const originalTab = store().activeTabId;
    store().newTab();
    const pending = deferred<WorkflowFile>();
    vi.mocked(hydrateWorkflowMedia).mockReturnValueOnce(pending.promise);
    const loading = store().loadWorkflow(file("Slow"), "/slow");

    expect(store().switchTab(originalTab)).toBe(true);
    pending.resolve(file("Slow"));
    await loading;
    expect(store().nodes[0].id).toBe("keep-me");
    expect(store().hasUnsavedChanges).toBe(true);
  });

  it("keeps the newest of two loads when the older one's media arrives last", async () => {
    const pending = deferred<WorkflowFile>();
    vi.mocked(hydrateWorkflowMedia).mockReturnValueOnce(pending.promise);
    const oldLoad = store().loadWorkflow(file("Old"), "/old");
    await store().loadWorkflow(file("New"), "/new");
    pending.resolve(file("Old"));
    await oldLoad;
    expect(store().workflowName).toBe("New");
    expect(store().nodes[0].id).toBe("New-node");
  });

  it("stays clear when it was cleared during a load", async () => {
    const pending = deferred<WorkflowFile>();
    vi.mocked(hydrateWorkflowMedia).mockReturnValueOnce(pending.promise);
    const loading = store().loadWorkflow(file("Old"), "/old");
    store().clearWorkflow();
    pending.resolve(file("Old"));
    await loading;
    expect(store().nodes).toEqual([]);
    expect(store().workflowName).toBeNull();
  });

  it("gets none of a finished save's refs or metadata", async () => {
    const pending = deferred<{ json: () => Promise<{ success: boolean }> }>();
    vi.mocked(fetch).mockReturnValueOnce(pending.promise as Promise<Response>);
    useWorkflowStore.setState({ nodes: [node("same-id", { image: "old" })] });
    const saving = store().saveToFile();
    await vi.waitFor(() => expect(fetch).toHaveBeenCalledOnce());
    await store().loadWorkflow(file("Replacement"), "/replacement");
    pending.resolve({ json: async () => ({ success: true }) });
    expect(await saving).toBe(false);
    expect(store().workflowName).toBe("Replacement");
    expect(store().imageRefBasePath).toBe("/replacement");
    expect(store().lastSavedAt).toBeNull();
    expect(store().isSaving).toBe(false);
  });
});

describe("overlapping saves", () => {
  it("run one after the other, and Save As takes the new name only after the first", async () => {
    const pending = deferred<WorkflowFile>();
    useWorkflowStore.setState({ nodes: [node("media-1", { image: "a" })] });
    vi.mocked(externalizeWorkflowMedia).mockReturnValueOnce(pending.promise);
    const first = store().saveToFile();
    await vi.waitFor(() => expect(externalizeWorkflowMedia).toHaveBeenCalledOnce());

    const second = store().saveToFile();
    const saveAs = store().saveAsFile("Different");
    await Promise.resolve();
    // Neither starts, and the identity the first save is writing stays put
    expect(externalizeWorkflowMedia).toHaveBeenCalledOnce();
    expect(store().workflowName).toBe("Original");

    pending.resolve(vi.mocked(externalizeWorkflowMedia).mock.calls[0][0]);
    expect(await first).toBe(true);
    expect(await second).toBe(true);
    expect(await saveAs).toBe(true);
    expect(store().workflowName).toBe("Different");
    expect(store().isSaving).toBe(false);
    // Each save posted the identity it was started with
    const posted = vi.mocked(fetch).mock.calls.map(([, init]) => JSON.parse((init as RequestInit).body as string).filename);
    expect(posted).toEqual(["Original", "Original", "Different"]);
  });
});

describe("media a save writes into the folder", () => {
  it("are held by reference from then on, and anything else stays as it was", async () => {
    const png = "data:image/png;base64,cG5n";
    const video = "data:video/mp4;base64,bXA0";
    useWorkflowStore.setState({
      nodes: [
        node("image-1", { image: png }),
        node("video-1", { video }, "videoInput"),
        node("gen-1", { inputImages: [png], outputImage: png }, "nanoBanana"),
        node("video-2", { video: "blob:http://localhost/v" }, "videoInput"),
      ],
    });
    vi.mocked(externalizeWorkflowMedia).mockImplementationOnce(async (workflow) => ({
      ...workflow,
      nodes: [
        node("image-1", { image: null, imageRef: "img-a" }),
        node("video-1", { video: null, videoRef: "vid-a" }, "videoInput"),
        node("gen-1", { inputImages: [""], inputImageRefs: ["img-b"], outputImage: null, outputImageRef: "img-c" }, "nanoBanana"),
        node("video-2", { video: "blob:http://localhost/v" }, "videoInput"),
      ],
    }));

    expect(await store().saveToFile()).toBe(true);
    const [image, videoNode, generate, unsaved] = store().nodes;
    expect(image.data).toMatchObject({ image: workflowImageReference("/project", "img-a"), imageRef: "img-a" });
    expect(videoNode.data).toMatchObject({ video: workflowImageReference("/project", "vid-a"), videoRef: "vid-a" });
    expect(generate.data).toMatchObject({
      inputImages: [workflowImageReference("/project", "img-b")],
      outputImage: workflowImageReference("/project", "img-c"),
    });
    // Media the save did not write keeps what it held
    expect(unsaved.data).toEqual({ video: "blob:http://localhost/v" });
    expect(store().hasUnsavedChanges).toBe(false);
  });
});
