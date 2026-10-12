import { NextRequest, NextResponse } from "next/server";
import * as fs from "fs/promises";
import * as path from "path";
import { guardAssetRequest } from "@/lib/assets/server/guard";
import { decodeBase64, parseDataUrl } from "@/utils/dataUrl";
import { logger } from "@/utils/logger";
import { sniffExtension } from "@/utils/mediaSniff";
import { validateWorkflowPath } from "@/utils/pathValidation";

export const maxDuration = 300; // 5 minute timeout for large image operations

// Both handlers answer only Node Banana's own page (see guard.ts).

const IMAGES_FOLDER = "inputs";
const LEGACY_IMAGES_FOLDER = ".images"; // For backward compatibility

/** Image extensions GET looks for, in order, and the MIME type it serves each as. */
const IMAGE_EXTENSIONS: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  svg: "image/svg+xml",
};

const MIME_TO_EXTENSION: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/jpg": "jpg",
  "image/gif": "gif",
  "image/webp": "webp",
  "image/svg+xml": "svg",
};

/** The bytes of a data: URL (any media type, or none), else of raw base64; null when it is neither. */
function decodeImageData(imageData: string): { bytes: Uint8Array; mime: string } | null {
  if (imageData.slice(0, 5).toLowerCase() === "data:") {
    const parsed = parseDataUrl(imageData);
    return parsed ? { bytes: parsed.bytes, mime: parsed.mime } : null;
  }
  const bytes = decodeBase64(imageData);
  return bytes ? { bytes, mime: "" } : null;
}

/** The extension to save under: what the bytes prove (if GET can load it), else the declared type, else png. */
function imageExtension(bytes: Uint8Array, mime: string): string {
  const sniffed = sniffExtension(bytes, "image");
  if (sniffed && sniffed in IMAGE_EXTENSIONS) return sniffed;
  return MIME_TO_EXTENSION[mime] ?? "png";
}

// POST: Save an image to the workflow's inputs or generations folder
export async function POST(request: NextRequest) {
  const refused = guardAssetRequest(request);
  if (refused) return refused;
  let workflowPath: string | undefined;
  let imageId: string | undefined;
  let folder: string | undefined;
  try {
    const body = await request.json();
    workflowPath = body.workflowPath;
    imageId = body.imageId;
    folder = body.folder || IMAGES_FOLDER; // Default to "inputs"
    const imageData = body.imageData; // Base64 data URL

    // Validate folder is one of the allowed values
    if (folder !== IMAGES_FOLDER && folder !== "generations") {
      folder = IMAGES_FOLDER;
    }

    logger.info('file.save', 'Workflow image save request received', {
      workflowPath,
      imageId,
      folder,
      hasImageData: !!imageData,
    });

    if (!workflowPath || !imageId || !imageData) {
      logger.warn('file.save', 'Workflow image save validation failed: missing fields', {
        hasWorkflowPath: !!workflowPath,
        hasImageId: !!imageId,
        hasImageData: !!imageData,
      });
      return NextResponse.json(
        { success: false, error: "Missing required fields (workflowPath, imageId, imageData)" },
        { status: 400 }
      );
    }

    // Validate path to prevent traversal attacks
    const pathValidation = validateWorkflowPath(workflowPath);
    if (!pathValidation.valid) {
      logger.warn('file.error', 'Workflow image save failed: invalid path', {
        workflowPath,
        error: pathValidation.error,
      });
      return NextResponse.json(
        { success: false, error: pathValidation.error },
        { status: 400 }
      );
    }

    // Only the payload is decoded (whatever media type the URL declares, or none):
    // decoding the whole string would write noise no decoder can open.
    const decoded = typeof imageData === "string" ? decodeImageData(imageData) : null;
    if (!decoded) {
      logger.warn('file.save', 'Workflow image save failed: imageData is not a data URL or base64', {
        workflowPath,
        imageId,
      });
      return NextResponse.json(
        { success: false, error: "imageData is not a readable data URL or base64" },
        { status: 400 }
      );
    }

    // Validate workflow directory exists, or create it if missing
    try {
      const stats = await fs.stat(workflowPath);
      if (!stats.isDirectory()) {
        logger.warn('file.error', 'Workflow image save failed: path is not a directory', {
          workflowPath,
        });
        return NextResponse.json(
          { success: false, error: "Workflow path is not a directory" },
          { status: 400 }
        );
      }
    } catch (dirError) {
      const err = dirError as NodeJS.ErrnoException;
      const isNotFound =
        err?.code === "ENOENT" ||
        (typeof err?.message === "string" &&
          (err.message.includes("ENOENT") || err.message.includes("no such file or directory")));

      if (!isNotFound) {
        logger.warn('file.error', 'Workflow image save failed: directory validation error', {
          workflowPath,
          error: dirError instanceof Error ? dirError.message : 'Unknown error',
        });
        return NextResponse.json(
          { success: false, error: "Directory validation failed" },
          { status: 400 }
        );
      }

      try {
        await fs.mkdir(workflowPath, { recursive: true });
        logger.info('file.save', 'Created workflow directory for image save', {
          workflowPath,
        });
      } catch (mkdirError) {
        logger.error('file.error', 'Failed to create workflow directory', {
          workflowPath,
        }, mkdirError instanceof Error ? mkdirError : undefined);
        return NextResponse.json(
          { success: false, error: "Failed to create workflow directory" },
          { status: 500 }
        );
      }
    }

    // Create target folder if it doesn't exist
    const targetFolder = path.join(workflowPath, folder);
    try {
      await fs.mkdir(targetFolder, { recursive: true });
    } catch (mkdirError) {
      logger.error('file.error', 'Failed to create target folder', {
        targetFolder,
      }, mkdirError instanceof Error ? mkdirError : undefined);
      return NextResponse.json(
        { success: false, error: "Failed to create target folder" },
        { status: 500 }
      );
    }

    // Sanitize imageId to prevent path traversal
    const safeImageId = path.basename(imageId);
    if (safeImageId !== imageId || imageId.includes('..')) {
      return NextResponse.json(
        { success: false, error: "Invalid imageId" },
        { status: 400 }
      );
    }

    // The bytes pick the extension when they prove a format; the declared type is only a label.
    const extension = imageExtension(decoded.bytes, decoded.mime);
    const filename = `${safeImageId}.${extension}`;
    const filePath = path.join(targetFolder, filename);
    const buffer = Buffer.from(decoded.bytes.buffer, decoded.bytes.byteOffset, decoded.bytes.byteLength);

    // Write the image file
    await fs.writeFile(filePath, buffer);

    logger.info('file.save', 'Workflow image saved successfully', {
      filePath,
      imageId,
      fileSize: buffer.length,
    });

    return NextResponse.json({
      success: true,
      imageId,
      filePath,
    });
  } catch (error) {
    logger.error('file.error', 'Failed to save workflow image', {
      workflowPath,
      imageId,
    }, error instanceof Error ? error : undefined);
    return NextResponse.json(
      {
        success: false,
        error: error instanceof Error ? error.message : "Save failed",
      },
      { status: 500 }
    );
  }
}

/** Stems of every file under the workflow's media folders (inputs, generations, legacy .images). */
async function listMediaIds(workflowPath: string): Promise<string[]> {
  const ids = new Set<string>();
  for (const sub of [IMAGES_FOLDER, "generations", LEGACY_IMAGES_FOLDER]) {
    let names: string[] = [];
    try {
      names = await fs.readdir(path.join(workflowPath, sub));
    } catch {
      continue;
    }
    for (const name of names) {
      const dot = name.lastIndexOf(".");
      ids.add(dot > 0 ? name.slice(0, dot) : name);
    }
  }
  return [...ids];
}

// GET: Load an image from the workflow's folders (inputs, generations, or legacy .images)
export async function GET(request: NextRequest) {
  const refused = guardAssetRequest(request);
  if (refused) return refused;
  const workflowPath = request.nextUrl.searchParams.get("workflowPath");
  const imageId = request.nextUrl.searchParams.get("imageId");
  const folder = request.nextUrl.searchParams.get("folder"); // Optional hint for which folder to check first

  // ?list=1: the ids of every media file the folder holds, so a save can tell a
  // ref that still has its file from one that does not before trusting it.
  if (request.nextUrl.searchParams.get("list") === "1") {
    if (!workflowPath) return NextResponse.json({ success: false, error: "Missing workflowPath" }, { status: 400 });
    const pathValidation = validateWorkflowPath(workflowPath);
    if (!pathValidation.valid) return NextResponse.json({ success: false, error: pathValidation.error }, { status: 400 });
    return NextResponse.json({ success: true, ids: await listMediaIds(workflowPath) });
  }

  // ?raw=1: the image's bytes, for node data that holds it by reference
  // (see src/lib/media/references.ts). A canvas can ask for thousands, so
  // these are not logged one by one.
  const raw = request.nextUrl.searchParams.get("raw") === "1";

  if (!raw) logger.info('file.load', 'Workflow image load request received', {
    workflowPath,
    imageId,
    folder,
  });

  if (!workflowPath || !imageId) {
    logger.warn('file.load', 'Workflow image load validation failed: missing parameters', {
      hasWorkflowPath: !!workflowPath,
      hasImageId: !!imageId,
    });
    return NextResponse.json(
      { success: false, error: "Missing required parameters (workflowPath, imageId)" },
      { status: 400 }
    );
  }

  try {
    // Validate path to prevent traversal attacks
    const pathValidation = validateWorkflowPath(workflowPath);
    if (!pathValidation.valid) {
      logger.warn('file.error', 'Workflow image load failed: invalid path', {
        workflowPath,
        error: pathValidation.error,
      });
      return NextResponse.json(
        { success: false, error: pathValidation.error },
        { status: 400 }
      );
    }

    // Sanitize imageId to prevent path traversal
    const safeImageId = path.basename(imageId);
    if (safeImageId !== imageId || imageId.includes('..')) {
      return NextResponse.json(
        { success: false, error: "Invalid imageId" },
        { status: 400 }
      );
    }

    // Validate workflow directory exists
    try {
      const stats = await fs.stat(workflowPath);
      if (!stats.isDirectory()) {
        return NextResponse.json(
          { success: false, error: "Workflow path is not a directory" },
          { status: 400 }
        );
      }
    } catch {
      return NextResponse.json(
        { success: false, error: "Workflow directory does not exist" },
        { status: 400 }
      );
    }

    // Construct file path - check folders and extensions in order
    const possibleExtensions = Object.keys(IMAGE_EXTENSIONS);
    const inputsFolder = path.join(workflowPath, IMAGES_FOLDER);
    const generationsFolder = path.join(workflowPath, "generations");
    const legacyFolder = path.join(workflowPath, LEGACY_IMAGES_FOLDER);

    // Build search order based on folder hint
    const searchOrder = folder === "generations"
      ? [generationsFolder, inputsFolder, legacyFolder]
      : [inputsFolder, generationsFolder, legacyFolder];

    let filePath: string | null = null;
    let foundExtension = "png"; // Track which extension was found

    // Check each folder and extension combination in order
    for (const searchFolder of searchOrder) {
      for (const ext of possibleExtensions) {
        const filename = `${safeImageId}.${ext}`;
        const candidatePath = path.join(searchFolder, filename);
        try {
          await fs.access(candidatePath);
          filePath = candidatePath;
          foundExtension = ext;
          if (searchFolder === legacyFolder) {
            logger.info('file.load', 'Found image in legacy .images folder', { filePath });
          }
          break;
        } catch {
          // File not found with this extension, try next
        }
      }
      if (filePath) break; // Stop searching if file was found
    }

    if (raw) {
      if (!filePath) return new NextResponse(null, { status: 404 });
      const bytes = await fs.readFile(filePath);
      return new NextResponse(new Uint8Array(bytes), {
        headers: {
          "Content-Type": IMAGE_EXTENSIONS[foundExtension] ?? "image/png",
          "Content-Length": String(bytes.length),
          // The file under an id can be rewritten, so the browser checks again
          "Cache-Control": "no-cache",
        },
      });
    }

    if (!filePath) {
      // Return 200 with success: false to avoid Next.js error overlay
      // Missing files are expected when workflow refs point to deleted/moved images
      logger.info('file.load', 'Workflow image not found (expected for missing refs)', {
        imageId,
        searchedFolders: searchOrder,
      });
      return NextResponse.json({
        success: false,
        error: "Image file not found",
        notFound: true,
      });
    }

    // Read the image file
    const buffer = await fs.readFile(filePath);

    // Convert to base64 data URL with correct MIME type
    const base64 = buffer.toString("base64");
    const mimeType = IMAGE_EXTENSIONS[foundExtension] ?? "image/png";
    const dataUrl = `data:${mimeType};base64,${base64}`;

    logger.info('file.load', 'Workflow image loaded successfully', {
      filePath,
      imageId,
      fileSize: buffer.length,
    });

    return NextResponse.json({
      success: true,
      imageId,
      image: dataUrl,
    });
  } catch (error) {
    logger.error('file.error', 'Failed to load workflow image', {
      workflowPath,
      imageId,
    }, error instanceof Error ? error : undefined);
    return NextResponse.json(
      {
        success: false,
        error: error instanceof Error ? error.message : "Load failed",
      },
      { status: 500 }
    );
  }
}
