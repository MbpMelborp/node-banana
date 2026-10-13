import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { NextRequest } from "next/server";

const mockStat = vi.fn();
const mockMkdir = vi.fn();
const mockWriteFile = vi.fn();
const mockAccess = vi.fn();
const mockReadFile = vi.fn();

vi.mock("fs/promises", () => ({
  stat: (...args: unknown[]) => mockStat(...args),
  mkdir: (...args: unknown[]) => mockMkdir(...args),
  writeFile: (...args: unknown[]) => mockWriteFile(...args),
  access: (...args: unknown[]) => mockAccess(...args),
  readFile: (...args: unknown[]) => mockReadFile(...args),
}));

// ?raw=1 streams through serveFile, covered against real files in raw.test.ts.
vi.mock("@/app/api/assets/_lib/files", () => ({ serveFile: vi.fn() }));

vi.mock("@/utils/logger", () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

// The request guard is covered by src/app/api/__tests__/fileRoutesGuard.test.ts.
vi.mock("@/lib/assets/server/guard", () => ({ guardAssetRequest: vi.fn(() => null) }));

import { GET, POST } from "../route";
import { makePng } from "@/lib/assets/server/__tests__/helpers";

function createMockPostRequest(body: unknown): NextRequest {
  return {
    json: vi.fn().mockResolvedValue(body),
  } as unknown as NextRequest;
}

describe("/api/workflow-images route", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.resetAllMocks();
  });

  describe("POST - Save workflow image", () => {
    it("should save image when workflow directory exists", async () => {
      mockStat.mockResolvedValue({
        isDirectory: () => true,
      });
      mockMkdir.mockResolvedValue(undefined);
      mockWriteFile.mockResolvedValue(undefined);

      const request = createMockPostRequest({
        workflowPath: "/test/workflow",
        imageId: "img_123",
        folder: "inputs",
        imageData: "data:image/png;base64,aGVsbG8=",
      });

      const response = await POST(request);
      const data = await response.json();

      expect(data.success).toBe(true);
      expect(data.imageId).toBe("img_123");
      expect(data.filePath).toBe("/test/workflow/inputs/img_123.png");
      expect(mockMkdir).toHaveBeenCalledWith("/test/workflow/inputs", { recursive: true });
      expect(mockWriteFile).toHaveBeenCalled();
    });

    it("should create missing workflow directory and save image", async () => {
      mockStat.mockRejectedValue(new Error("ENOENT"));
      mockMkdir.mockResolvedValue(undefined);
      mockWriteFile.mockResolvedValue(undefined);

      const request = createMockPostRequest({
        workflowPath: "/test/new-workflow",
        imageId: "img_123",
        folder: "inputs",
        imageData: "data:image/png;base64,aGVsbG8=",
      });

      const response = await POST(request);
      const data = await response.json();

      expect(data.success).toBe(true);
      expect(mockMkdir).toHaveBeenCalledWith("/test/new-workflow", { recursive: true });
      expect(mockMkdir).toHaveBeenCalledWith("/test/new-workflow/inputs", { recursive: true });
    });

    it("should reject path traversal attempts", async () => {
      const request = createMockPostRequest({
        workflowPath: "/test/../etc/passwd",
        imageId: "img_123",
        folder: "inputs",
        imageData: "data:image/png;base64,aGVsbG8=",
      });

      const response = await POST(request);
      const data = await response.json();

      expect(response.status).toBe(400);
      expect(data.success).toBe(false);
      expect(data.error).toBe("Path contains traversal sequences");
    });

    it("should reject non-absolute paths", async () => {
      const request = createMockPostRequest({
        workflowPath: "relative/path",
        imageId: "img_123",
        folder: "inputs",
        imageData: "data:image/png;base64,aGVsbG8=",
      });

      const response = await POST(request);
      const data = await response.json();

      expect(response.status).toBe(400);
      expect(data.success).toBe(false);
      expect(data.error).toBe("Path must be absolute");
    });

    it("should reject dangerous system paths", async () => {
      const request = createMockPostRequest({
        workflowPath: "/etc/workflows",
        imageId: "img_123",
        folder: "inputs",
        imageData: "data:image/png;base64,aGVsbG8=",
      });

      const response = await POST(request);
      const data = await response.json();

      expect(response.status).toBe(400);
      expect(data.success).toBe(false);
      expect(data.error).toBe("Access to /etc is not allowed");
    });
  });

  // The bug: a data URL the old regex didn't match (no type, octet-stream, parameters, svg+xml)
  // was base64-decoded whole, header included, and the file on disk was noise.
  describe("POST - decoding the image", () => {
    const png = makePng(5, 3);
    const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01]);
    const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="4" height="4"><rect width="4" height="4"/></svg>';

    async function save(imageData: string) {
      mockStat.mockResolvedValue({ isDirectory: () => true });
      mockMkdir.mockResolvedValue(undefined);
      mockWriteFile.mockResolvedValue(undefined);
      const response = await POST(
        createMockPostRequest({ workflowPath: "/test/workflow", imageId: "img_1", folder: "generations", imageData }),
      );
      const data = await response.json();
      const [filePath, bytes] = (mockWriteFile.mock.calls[0] ?? []) as [string?, Buffer?];
      return { status: response.status, data, filePath, bytes };
    }

    it.each([
      ["no media type", `data:;base64,${png.toString("base64")}`],
      ["application/octet-stream", `data:application/octet-stream;base64,${png.toString("base64")}`],
      ["a ;charset= parameter", `data:image/png;charset=utf-8;base64,${png.toString("base64")}`],
      ["a bare word for a type", `data:image;base64,${png.toString("base64")}`],
    ])("writes the exact bytes of a PNG declared with %s", async (_, imageData) => {
      const { data, filePath, bytes } = await save(imageData);
      expect(data.success).toBe(true);
      expect(filePath).toBe("/test/workflow/generations/img_1.png");
      expect(Buffer.from(bytes!).equals(png)).toBe(true);
    });

    it("names the file after the bytes, not the declared type", async () => {
      const { filePath, bytes } = await save(`data:image/png;base64,${jpeg.toString("base64")}`);
      expect(filePath).toBe("/test/workflow/generations/img_1.jpg");
      expect(Buffer.from(bytes!).equals(jpeg)).toBe(true);
    });

    it("saves image/svg+xml, percent-encoded or base64, as .svg", async () => {
      const percent = await save(`data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`);
      expect(percent.filePath).toBe("/test/workflow/generations/img_1.svg");
      expect(Buffer.from(percent.bytes!).toString("utf8")).toBe(svg);
      mockWriteFile.mockClear();
      const base64 = await save(`data:image/svg+xml;base64,${Buffer.from(svg).toString("base64")}`);
      expect(base64.filePath).toBe("/test/workflow/generations/img_1.svg");
      expect(Buffer.from(base64.bytes!).toString("utf8")).toBe(svg);
    });

    it("falls back to the declared type, then png, when the bytes prove nothing", async () => {
      expect((await save("data:image/webp;base64,aGVsbG8=")).filePath).toBe("/test/workflow/generations/img_1.webp");
      mockWriteFile.mockClear();
      expect((await save("aGVsbG8=")).filePath).toBe("/test/workflow/generations/img_1.png");
    });

    it("refuses what it can't decode instead of writing noise", async () => {
      const { status, data } = await save("data:image/png;base64,!!not base64!!");
      expect(status).toBe(400);
      expect(data.success).toBe(false);
      expect(mockWriteFile).not.toHaveBeenCalled();
    });
  });
});
