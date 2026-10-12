import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  assetReference,
  clearMediaReferenceCache,
  inlineMediaReferences,
  isMediaReference,
  workflowImageReference,
} from "../references";

const BYTES = "hello";
const DATA_URL = `data:image/png;base64,${btoa(BYTES)}`;

describe("media references", () => {
  const fetchMock = vi.fn();
  beforeEach(() => {
    clearMediaReferenceCache();
    fetchMock.mockReset();
    // jsdom's FileReader reads only jsdom's own Blob
    fetchMock.mockImplementation(async () => ({ ok: true, status: 200, blob: async () => new Blob([BYTES], { type: "image/png" }) }));
    vi.stubGlobal("fetch", fetchMock);
  });
  afterEach(() => vi.unstubAllGlobals());

  it("tells references apart from other media and text", () => {
    expect(isMediaReference(assetReference("abc"))).toBe(true);
    expect(isMediaReference(workflowImageReference("/p/My Project", "img-1"))).toBe(true);
    expect(isMediaReference("/api/workflow-images?workflowPath=/p&imageId=x")).toBe(false);
    expect(isMediaReference(DATA_URL)).toBe(false);
    expect(isMediaReference("https://example.com/a.png")).toBe(false);
    expect(isMediaReference("a prompt about /api/assets/x/file")).toBe(false);
  });

  it("puts each reference's data URL in its place, at any depth, and leaves the rest alone", async () => {
    const ref = assetReference("abc");
    const untouched = { prompt: "a fox" };
    const body = { images: [ref, DATA_URL], nested: { image: ref }, untouched };
    const inlined = await inlineMediaReferences(body);
    expect(inlined).toEqual({ images: [DATA_URL, DATA_URL], nested: { image: DATA_URL }, untouched });
    expect(inlined.untouched).toBe(untouched);
    // One read for the one reference
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(body.images[0]).toBe(ref);
  });

  it("returns the value itself when it holds no reference", async () => {
    const body = { images: [DATA_URL] };
    expect(await inlineMediaReferences(body)).toBe(body);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("reuses a resolved reference and fails when its file is gone", async () => {
    const ref = workflowImageReference("/p", "img-1");
    await inlineMediaReferences([ref]);
    await inlineMediaReferences([ref]);
    expect(fetchMock).toHaveBeenCalledTimes(1);

    fetchMock.mockResolvedValueOnce({ ok: false, status: 404 });
    await expect(inlineMediaReferences([assetReference("gone")])).rejects.toThrow("404");
  });
});
