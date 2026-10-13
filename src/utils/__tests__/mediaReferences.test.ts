/**
 * Saved workflows' images held by reference: opening one references the
 * folder's files rather than reading them, and saving it again writes the
 * same file as before.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { hydrateWorkflowMedia, settleMediaReferences } from "../mediaStorage";
import { assetReference, clearMediaReferenceCache, workflowImageReference } from "@/lib/media/references";
import type { WorkflowNode } from "@/types";
import type { WorkflowFile } from "@/store/workflowStore";

const FOLDER = "/projects/Cars";
const PNG = `data:image/png;base64,${btoa("png")}`;

const node = (type: string, data: Record<string, unknown>): WorkflowNode =>
  ({ id: `${type}-1`, type, position: { x: 0, y: 0 }, data }) as WorkflowNode;

describe("media references in saved workflows", () => {
  const fetchMock = vi.fn();
  beforeEach(() => {
    clearMediaReferenceCache();
    fetchMock.mockReset();
    vi.stubGlobal("fetch", fetchMock);
  });
  afterEach(() => vi.unstubAllGlobals());

  it("opens a workflow with its images as references, and an image the folder lacks as missing", async () => {
    fetchMock.mockImplementation(async (url: string) => {
      if (url.includes("list=1")) return Response.json({ success: true, ids: ["img-a", "img-b"] });
      throw new Error(`unexpected ${url}`);
    });
    const workflow = {
      version: 1, name: "Cars", edges: [],
      nodes: [
        node("imageInput", { image: null, imageRef: "img-a" }),
        node("nanoBanana", { outputImage: null, outputImageRef: "img-gone", inputImages: [], inputImageRefs: ["img-b"] }),
      ],
    } as unknown as WorkflowFile;

    const opened = await hydrateWorkflowMedia(workflow, FOLDER);
    expect((opened.nodes[0].data as { image: string }).image).toBe(workflowImageReference(FOLDER, "img-a"));
    const generate = opened.nodes[1].data as { outputImage: string; inputImages: string[] };
    expect(generate.outputImage).toBe("");
    expect(generate.inputImages).toEqual([workflowImageReference(FOLDER, "img-b")]);
    // One listing, no image read
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("opens video and audio as references, and reads legacy files from the workflow's own folder", async () => {
    fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
      if (url.includes("list=1")) return Response.json({ success: true, ids: ["vid-a", "aud-a"] });
      if (url === "/api/load-generation") {
        const { directoryPath } = JSON.parse(init!.body as string);
        return Response.json(directoryPath === FOLDER
          ? { success: true, contentType: "video", video: "data:video/mp4;base64,b2xk" }
          : { success: false, notFound: true });
      }
      throw new Error(`unexpected ${url}`);
    });
    const workflow = {
      version: 1, name: "Cars", edges: [],
      nodes: [
        { ...node("videoInput", { video: null, videoRef: "vid-a" }), id: "v1" },
        { ...node("generateAudio", { outputAudio: null, outputAudioRef: "aud-a" }), id: "a1" },
        { ...node("videoInput", { video: null, videoRef: "vid-old" }), id: "v2" },
      ],
    } as unknown as WorkflowFile;

    const opened = await hydrateWorkflowMedia(workflow, FOLDER);
    expect((opened.nodes[0].data as { video: string }).video).toBe(workflowImageReference(FOLDER, "vid-a"));
    expect((opened.nodes[1].data as { outputAudio: string }).outputAudio).toBe(workflowImageReference(FOLDER, "aud-a"));
    expect((opened.nodes[2].data as { video: string }).video).toBe("data:video/mp4;base64,b2xk");
  });

  it("strips a reference to its own file in this folder, as the save strips media with a ref", async () => {
    const own = workflowImageReference(FOLDER, "img-a");
    const settled = await settleMediaReferences(
      node("nanoBanana", { outputImage: own, outputImageRef: "img-a", inputImages: [own], inputImageRefs: ["img-a"] }),
      FOLDER,
    );
    expect(settled.data).toMatchObject({ outputImage: null, inputImages: [""] });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("reads back an asset or another folder's file, so the save writes it here", async () => {
    // jsdom's FileReader reads only jsdom's own Blob
    fetchMock.mockImplementation(async () => ({ ok: true, status: 200, blob: async () => new Blob(["png"], { type: "image/png" }) }));
    const settled = await settleMediaReferences(
      node("imageCompare", { imageA: assetReference("abc"), imageB: workflowImageReference("/elsewhere", "img-a"), imageBRef: "img-a" }),
      FOLDER,
    );
    expect(settled.data).toMatchObject({ imageA: PNG, imageB: PNG });
  });

  it("drops a Comfy output kept in this folder from the map and from its typed mirror", async () => {
    const own = workflowImageReference(FOLDER, "img-a");
    const settled = await settleMediaReferences(
      node("comfyApp", { outputs: { "9": own, "12": "notes" }, outputRefs: { "9": "img-a" }, outputImage: own }),
      FOLDER,
    );
    expect(settled.data).toMatchObject({ outputs: { "12": "notes" }, outputImage: null });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("returns a node without references as it was", async () => {
    const plain = node("imageInput", { image: PNG });
    expect(await settleMediaReferences(plain, FOLDER)).toBe(plain);
  });
});
