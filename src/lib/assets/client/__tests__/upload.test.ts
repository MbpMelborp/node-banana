import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { RUN_ID_PATTERN, WORKFLOW_ID_PATTERN, type AssetRunContext, type RecordAssetInput } from "../../types";
import type { RecordAssetOptions } from "../recorder";
import { measureMedia, NOT_MEDIA_REASON, recordUpload, uploadKindOf, UPLOADS_WORKFLOW_ID } from "../upload";
import { assetView, recordResult } from "./helpers";

const m = vi.hoisted(() => ({ recordAsset: vi.fn(), patchAsset: vi.fn() }));
vi.mock("../recorder", () => ({ recordAsset: m.recordAsset }));
vi.mock("../api", () => ({ patchAsset: m.patchAsset }));

const EDIT = "ed0000000000a1";
const uploaded = assetView({
  id: "aupload0000001",
  kind: "video",
  origin: "uploaded",
  mime: "video/mp4",
  ext: "mp4",
  filename: "143205_upload_ab12cd34.mp4",
  name: "sunset.mp4",
  prompt: undefined,
  durationSec: 5,
});

const video = (name = "sunset.mp4", type = "video/mp4") => new File(["v"], name, { type });
const measure = vi.fn(async () => ({ durationSec: 5.2, width: 1920, height: 1080 }));

/** recordAsset as it answers: `done` with the record, or null after `failed` says why. */
function answer(outcome: { asset?: typeof uploaded; reason?: string }) {
  m.recordAsset.mockImplementation(() => ({
    assetId: outcome.asset?.id ?? "afailed0000001",
    done: Promise.resolve(outcome.asset ? recordResult(outcome.asset) : null),
    held: new Promise(() => {}),
    failed: outcome.reason !== undefined ? Promise.resolve(outcome.reason) : new Promise(() => {}),
  }));
}

function recorded() {
  return m.recordAsset.mock.calls[0] as [RecordAssetInput, AssetRunContext, RecordAssetOptions];
}

beforeEach(() => {
  m.recordAsset.mockReset();
  m.patchAsset.mockReset().mockResolvedValue(undefined);
  measure.mockClear();
  answer({ asset: uploaded });
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("uploadKindOf", () => {
  it("tells video and audio by the file's type", () => {
    expect(uploadKindOf({ name: "clip", type: "video/mp4" })).toBe("video");
    expect(uploadKindOf({ name: "clip.mov", type: "video/quicktime" })).toBe("video");
    expect(uploadKindOf({ name: "song", type: "audio/mpeg" })).toBe("audio");
    // The type wins over the extension
    expect(uploadKindOf({ name: "voice.mp4", type: "audio/mp4" })).toBe("audio");
  });

  it("falls back to the extension when the browser gives no type", () => {
    expect(uploadKindOf({ name: "Take 2.MOV", type: "" })).toBe("video");
    expect(uploadKindOf({ name: "clip.mkv", type: "application/octet-stream" })).toBe("video");
    expect(uploadKindOf({ name: "song.flac", type: "" })).toBe("audio");
    expect(uploadKindOf({ name: "loop.aiff", type: "" })).toBe("audio");
  });

  it("is null for anything else", () => {
    expect(uploadKindOf({ name: "notes.txt", type: "text/plain" })).toBeNull();
    expect(uploadKindOf({ name: "photo.png", type: "image/png" })).toBeNull();
    expect(uploadKindOf({ name: "README", type: "" })).toBeNull();
  });
});

describe("recordUpload", () => {
  it("records the file as an upload under the edit it came in through, named as it was, and quietly", async () => {
    const file = video();
    await expect(recordUpload(file, { editId: EDIT, editName: "Trip" }, { measure })).resolves.toBe(uploaded);

    expect(measure).toHaveBeenCalledWith(file, "video");
    const [input, run, options] = recorded();
    expect(input).toEqual({
      kind: "video",
      origin: "uploaded",
      media: file,
      mime: "video/mp4",
      name: "sunset.mp4",
      producer: { nodeId: EDIT, nodeType: "editProject", nodeTitle: "Trip", operation: "upload" },
      durationSec: 5.2,
      width: 1920,
      height: 1080,
    });
    expect(run).toMatchObject({ workflowId: EDIT, workflowName: "Trip", projectDir: null });
    expect(run.runId).toMatch(RUN_ID_PATTERN);
    expect(typeof run.startedAt).toBe("number");
    expect(options).toEqual({ quiet: true });
  });

  it("lists an upload made outside an edit under Uploads", async () => {
    const sound = { ...uploaded, kind: "audio" as const };
    answer({ asset: sound });
    await expect(recordUpload(new File(["a"], "song.mp3", { type: "audio/mpeg" }), {}, { measure })).resolves.toBe(sound);
    const [input, run] = recorded();
    expect(input).toMatchObject({ kind: "audio", producer: { nodeId: "upload", nodeType: "upload", operation: "upload" } });
    expect(input.producer).not.toHaveProperty("nodeTitle");
    expect(run).toMatchObject({ workflowId: UPLOADS_WORKFLOW_ID, workflowName: "Uploads", projectDir: null });
    expect(UPLOADS_WORKFLOW_ID).toMatch(WORKFLOW_ID_PATTERN);
  });

  it("names an edit's upload without a title when the edit has no name yet", async () => {
    await recordUpload(video(), { editId: EDIT }, { measure });
    const [input, run] = recorded();
    expect(input.producer).toEqual({ nodeId: EDIT, nodeType: "editProject", operation: "upload" });
    expect(run.workflowName).toBeNull();
  });

  it("keeps the name to one line of 120 characters, its extension kept, and leaves out a type the browser didn't give", async () => {
    const long = `${"a".repeat(130)}.mp4`;
    await recordUpload(new File(["v"], long, { type: "" }), {}, { measure });
    await recordUpload(video("Day one\nfinal.mov", "video/quicktime"), {}, { measure });
    const first = m.recordAsset.mock.calls[0][0] as RecordAssetInput;
    const second = m.recordAsset.mock.calls[1][0] as RecordAssetInput;
    expect(first.name).toBe(`${"a".repeat(116)}.mp4`);
    expect(first.name).toHaveLength(120);
    expect(first.mime).toBeUndefined();
    expect(first.kind).toBe("video");
    expect(second.name).toBe("Day one final.mov");
  });

  it("doesn't cut a long name through the middle of an emoji", async () => {
    // 115 letters then an emoji (two UTF-16 units) straddling the 116 the name keeps before ".mp4"
    await recordUpload(new File(["v"], `${"a".repeat(115)}\u{1F305}tail.mp4`, { type: "video/mp4" }), {}, { measure });
    const [input] = recorded();
    expect(input.name).toBe(`${"a".repeat(115)}.mp4`);
  });

  it("refuses a file that is not video or audio before recording anything", async () => {
    await expect(recordUpload(new File(["x"], "notes.txt", { type: "text/plain" }), {}, { measure })).rejects.toThrow(NOT_MEDIA_REASON);
    expect(NOT_MEDIA_REASON).toBe("Only video and audio files can be added.");
    expect(measure).not.toHaveBeenCalled();
    expect(m.recordAsset).not.toHaveBeenCalled();
  });

  it("rejects with the recorder's reason when the library could not take it", async () => {
    answer({ reason: "The upload is over the 2 GB limit." });
    await expect(recordUpload(video(), { editId: EDIT }, { measure })).rejects.toThrow("The upload is over the 2 GB limit.");
  });

  it("rejects bytes nothing can read, and a file that turned out not to be video or audio", async () => {
    answer({ asset: { ...uploaded, unreadable: true } });
    await expect(recordUpload(video(), {}, { measure })).rejects.toThrow("The file couldn't be read as video or audio.");
    // Never listed, so left as any unreadable recording is
    expect(m.patchAsset).not.toHaveBeenCalled();
    answer({ asset: { ...uploaded, kind: "image" } });
    await expect(recordUpload(video(), {}, { measure })).rejects.toThrow("The file couldn't be read as video or audio.");
  });

  it("puts a file whose bytes are not video or audio in the Trash, so the library doesn't list it", async () => {
    answer({ asset: { ...uploaded, kind: "image", mime: "image/png", ext: "png" } });
    await expect(recordUpload(video(), {}, { measure })).rejects.toThrow("The file couldn't be read as video or audio.");
    expect(m.patchAsset).toHaveBeenCalledWith(uploaded.id, { trashed: true });

    // The reason stands when the Trash can't be reached
    m.patchAsset.mockRejectedValueOnce(new Error("offline"));
    await expect(recordUpload(video(), {}, { measure })).rejects.toThrow("The file couldn't be read as video or audio.");
  });

  it("records without a length or size when the browser can't measure the file", async () => {
    const failing = vi.fn(async () => {
      throw new Error("no decoder");
    });
    await expect(recordUpload(video(), {}, { measure: failing })).resolves.toBe(uploaded);
    const [input] = recorded();
    expect(input).not.toHaveProperty("durationSec");
    expect(input).not.toHaveProperty("width");
  });
});

describe("measureMedia", () => {
  function stubElements() {
    const elements: HTMLMediaElement[] = [];
    const create = document.createElement.bind(document);
    vi.spyOn(document, "createElement").mockImplementation(((tag: string, options?: ElementCreationOptions) => {
      const element = create(tag, options);
      if (element instanceof HTMLMediaElement) elements.push(element);
      return element;
    }) as typeof document.createElement);
    vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:upload");
    const revoke = vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => {});
    const load = vi.spyOn(HTMLMediaElement.prototype, "load").mockImplementation(() => {});
    return { elements, revoke, load };
  }

  it("reads a video's length and size from its metadata, then lets the file go", async () => {
    const { elements, revoke, load } = stubElements();
    const measuring = measureMedia(video(), "video");
    const [element] = elements;
    expect(element).toBeInstanceOf(HTMLVideoElement);
    expect(element.getAttribute("src")).toBe("blob:upload");
    Object.defineProperty(element, "duration", { value: 5.2 });
    Object.defineProperty(element, "videoWidth", { value: 1920 });
    Object.defineProperty(element, "videoHeight", { value: 1080 });
    element.dispatchEvent(new Event("loadedmetadata"));
    await expect(measuring).resolves.toEqual({ durationSec: 5.2, width: 1920, height: 1080 });
    expect(revoke).toHaveBeenCalledWith("blob:upload");
    expect(element.hasAttribute("src")).toBe(false);
    // Without a src, load() lets the element's player go
    expect(load).toHaveBeenCalledTimes(1);
  });

  it("reads a sound's length only, and leaves out a length that isn't one", async () => {
    const { elements } = stubElements();
    const sound = measureMedia(new File(["a"], "song.mp3", { type: "audio/mpeg" }), "audio");
    Object.defineProperty(elements[0], "duration", { value: 20 });
    elements[0].dispatchEvent(new Event("loadedmetadata"));
    await expect(sound).resolves.toEqual({ durationSec: 20 });

    const live = measureMedia(video("live.webm", "video/webm"), "video");
    Object.defineProperty(elements[1], "duration", { value: Infinity });
    elements[1].dispatchEvent(new Event("loadedmetadata"));
    await expect(live).resolves.toEqual({});
  });

  it("gives up on an error, or after three seconds", async () => {
    vi.useFakeTimers();
    const { elements, revoke, load } = stubElements();
    const broken = measureMedia(video(), "video");
    elements[0].dispatchEvent(new Event("error"));
    await expect(broken).resolves.toEqual({});

    const slow = measureMedia(video(), "video");
    await vi.advanceTimersByTimeAsync(2_999);
    let settled = false;
    void slow.then(() => (settled = true));
    await Promise.resolve();
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await expect(slow).resolves.toEqual({});
    expect(revoke).toHaveBeenCalledTimes(2);
    expect(load).toHaveBeenCalledTimes(2);
    expect(elements[1].hasAttribute("src")).toBe(false);
  });
});
