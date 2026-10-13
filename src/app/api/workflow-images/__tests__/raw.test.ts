// GET ?raw=1 against real files: the bytes behind media held by reference
// (src/lib/media/references.ts), images, video and audio alike.
import { describe, it, expect, vi, beforeAll, afterAll } from "vitest";
import { NextRequest } from "next/server";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

vi.mock("@/utils/logger", () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));
// The request guard is covered by src/app/api/__tests__/fileRoutesGuard.test.ts.
vi.mock("@/lib/assets/server/guard", () => ({ guardAssetRequest: vi.fn(() => null) }));

import { GET } from "../route";

let workflowPath: string;

beforeAll(async () => {
  workflowPath = await fs.mkdtemp(path.join(os.tmpdir(), "nb-raw-"));
  await fs.mkdir(path.join(workflowPath, "inputs"));
  await fs.mkdir(path.join(workflowPath, "generations"));
  await fs.writeFile(path.join(workflowPath, "inputs", "img_1.jpg"), "jpeg bytes");
  await fs.writeFile(path.join(workflowPath, "generations", "vid_1.mp4"), "0123456789");
  await fs.writeFile(path.join(workflowPath, "generations", "aud_1.mp3"), "mp3 bytes");
  // Saved before the generations/ folder existed
  await fs.writeFile(path.join(workflowPath, "vid_old.webm"), "old video");
});

afterAll(async () => {
  await fs.rm(workflowPath, { recursive: true, force: true });
});

function raw(imageId: string, headers?: Record<string, string>): NextRequest {
  const params = new URLSearchParams({ workflowPath, imageId, raw: "1" });
  return new NextRequest(`http://localhost/api/workflow-images?${params}`, { headers });
}

describe("GET /api/workflow-images?raw=1", () => {
  it("answers with an image's bytes and type", async () => {
    const response = await GET(raw("img_1"));
    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Type")).toBe("image/jpeg");
    expect(await response.text()).toBe("jpeg bytes");
  });

  it("serves video and audio from generations/", async () => {
    const video = await GET(raw("vid_1"));
    expect(video.headers.get("Content-Type")).toBe("video/mp4");
    expect(video.headers.get("Accept-Ranges")).toBe("bytes");
    expect(await video.text()).toBe("0123456789");

    const audio = await GET(raw("aud_1"));
    expect(audio.headers.get("Content-Type")).toBe("audio/mpeg");
    expect(await audio.text()).toBe("mp3 bytes");
  });

  it("answers a byte range, so a video can seek", async () => {
    const response = await GET(raw("vid_1", { range: "bytes=2-5" }));
    expect(response.status).toBe(206);
    expect(response.headers.get("Content-Range")).toBe("bytes 2-5/10");
    expect(await response.text()).toBe("2345");
  });

  it("finds video a save left in the workflow's own folder", async () => {
    const response = await GET(raw("vid_old"));
    expect(response.headers.get("Content-Type")).toBe("video/webm");
    expect(await response.text()).toBe("old video");
  });

  it("revalidates: an unchanged file answers 304", async () => {
    const first = await GET(raw("img_1"));
    const etag = first.headers.get("ETag");
    expect(etag).toBeTruthy();
    const again = await GET(raw("img_1", { "if-none-match": etag! }));
    expect(again.status).toBe(304);
  });

  it("answers 404 when the folder has no such file", async () => {
    const response = await GET(raw("img_gone"));
    expect(response.status).toBe(404);
  });

  it("refuses an id that leaves the folder", async () => {
    const response = await GET(raw("../secret"));
    expect(response.status).toBe(400);
  });
});
