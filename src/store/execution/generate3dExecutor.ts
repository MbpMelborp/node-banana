/**
 * Generate3D Executor
 *
 * Executor for generate3d (3D model generation) nodes.
 * Extracted from nanoBananaExecutor's 3D handling code.
 */

import type { Generate3DNodeData, SelectedModel } from "@/types";
import { buildGenerateHeaders } from "@/store/utils/buildApiHeaders";
import { pollGenerateTask } from "./pollTaskCompletion";
import { runWithFallback } from "./runWithFallback";
import type { NodeExecutionContext } from "./types";
import { MissingInputError } from "./missingInput";
import type { RecordAssetResult } from "@/lib/assets/types";
import {
  assetCost,
  assetModel,
  assetParameters,
  assetProducer,
  recordingResult,
  recordOutput,
  resolvedPrompt,
  withFolderFallback,
} from "./assetRecording";
import { inlineMediaReferences } from "@/lib/media/references";

export interface Generate3DOptions {
  /** When true, falls back to stored inputImages/inputPrompt if no connections provide them. */
  useStoredFallback?: boolean;
}

export async function executeGenerate3D(
  ctx: NodeExecutionContext,
  options: Generate3DOptions = {}
): Promise<void> {
  const {
    node,
    getConnectedInputs,
    updateNodeData,
    getFreshNode,
    signal,
    providerSettings,
    addIncurredCost,
    generationsPath,
    trackSaveGeneration,
  } = ctx;

  const { useStoredFallback = false } = options;

  const { images: connectedImages, text: connectedText, dynamicInputs } = getConnectedInputs(node.id);

  // Get fresh node data from store
  const freshNode = getFreshNode(node.id);
  const nodeData = (freshNode?.data || node.data) as Generate3DNodeData;

  // Determine images and text (with optional fallback to stored values)
  let images: string[];
  let promptText: string | null;

  if (useStoredFallback) {
    images = connectedImages.length > 0 ? connectedImages : nodeData.inputImages;
    promptText = connectedText ?? nodeData.inputPrompt;
  } else {
    images = connectedImages;
    const promptFromDynamic = Array.isArray(dynamicInputs.prompt)
      ? dynamicInputs.prompt[0]
      : dynamicInputs.prompt;
    promptText = connectedText || promptFromDynamic || null;
  }

  // 3D models may work with just images (image-to-3d) or just text (text-to-3d)
  if (!promptText && images.length === 0) {
    updateNodeData(node.id, {
      status: "skipped",
      error: "Missing text or image input",
    });
    throw new MissingInputError("Missing text or image input");
  }

  updateNodeData(node.id, {
    inputImages: images,
    inputPrompt: promptText,
    status: "loading",
    error: null,
  });

  const runOnce = async (modelToUse: SelectedModel, parametersOverride?: Record<string, unknown>): Promise<void> => {
    const provider = modelToUse.provider;
    const headers = buildGenerateHeaders(provider, providerSettings);

    const requestPayload = {
      images,
      prompt: promptText || "",
      selectedModel: modelToUse,
      parameters: parametersOverride ?? nodeData.parameters,
      dynamicInputs,
      mediaType: "3d" as const,
    };

    try {
      const response = await fetch("/api/generate", {
        method: "POST",
        headers,
        // Providers take media inline; node data may hold it by reference
        body: JSON.stringify(await inlineMediaReferences(requestPayload)),
        ...(signal ? { signal } : {}),
      });

      if (!response.ok) {
        const errorText = await response.text();
        let errorMessage = `HTTP ${response.status}`;
        try {
          const errorJson = JSON.parse(errorText);
          errorMessage = errorJson.error || errorMessage;
        } catch {
          if (errorText) errorMessage += ` - ${errorText.substring(0, 200)}`;
        }

        updateNodeData(node.id, {
          status: "error",
          error: errorMessage,
        });
        throw new Error(errorMessage);
      }

      let result = await response.json();

      // Handle polling response (long-running Kie tasks)
      if (result.polling) {
        result = await pollGenerateTask({
          taskId: result.taskId,
          provider: result.pollProvider,
          modelId: result.pollModelId,
          modelName: result.pollModelName,
          mediaType: result.pollMediaType,
          headers,
          signal,
        });

        if (!result.success) {
          updateNodeData(node.id, {
            status: "error",
            error: result.error || "3D generation failed",
          });
          throw new Error(result.error || "3D generation failed");
        }
      }

      if (result.success && result.model3dUrl) {
        const model3dUrl: string = result.model3dUrl;
        // The provider's URL expires, so the server downloads it right away
        const recorded = recordOutput(ctx, {
          kind: "3d",
          origin: "generated",
          media: model3dUrl,
          prompt: resolvedPrompt(promptText, dynamicInputs),
          model: assetModel(modelToUse),
          parameters: assetParameters(requestPayload.parameters),
          cost: assetCost(modelToUse.pricing?.amount),
          producer: assetProducer(ctx),
        });

        updateNodeData(node.id, {
          output3dUrl: model3dUrl,
          status: "complete",
          error: null,
          savedFilename: null,
          savedFilePath: null,
        });

        // Track cost if applicable
        if (modelToUse.pricing) {
          addIncurredCost(modelToUse.pricing.amount);
        }

        // The save to the generations folder: a project's only save without
        // the asset library, and its fallback when a recording fails
        const saveToFolder = generationsPath
          ? () =>
              fetch("/api/save-generation", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                  directoryPath: generationsPath,
                  model3d: model3dUrl,
                  prompt: promptText,
                }),
              })
                .then((res) => res.json())
                .then((saveResult) => {
                  if (saveResult.success && saveResult.filename) {
                    updateNodeData(node.id, {
                      savedFilename: saveResult.filename,
                      savedFilePath: saveResult.filePath,
                    });
                  }
                })
                .catch((err) => {
                  console.error("Failed to save 3D model:", err);
                })
          : null;

        if (recorded) {
          // Point the node at the saved file once it is on disk, unless the
          // node has moved on to another model (or the canvas to another workflow)
          const pointAtSaved = (saved: RecordAssetResult | null) => {
            if (!saved) return;
            const current = getFreshNode(node.id)?.data as Generate3DNodeData | undefined;
            if (current?.output3dUrl !== model3dUrl) return;
            updateNodeData(node.id, {
              savedFilename: saved.filename,
              savedFilePath: saved.asset.displayPath,
            });
          };
          if (saveToFolder) {
            // A project's model lands in its folder whatever the library does,
            // and whichever wrote the file first points the node at it
            trackSaveGeneration(
              `3d-${Date.now()}`,
              withFolderFallback(recorded, saveToFolder, (saved) => {
                if (!(getFreshNode(node.id)?.data as Generate3DNodeData | undefined)?.savedFilename) pointAtSaved(saved);
              })
            );
          } else {
            void recordingResult(recorded)
              .then(pointAtSaved)
              .catch((err) => {
                console.error("Failed to save 3D model:", err);
              });
          }
        } else if (saveToFolder) {
          // No asset library: auto-save 3D model to the generations folder
          trackSaveGeneration(`3d-${Date.now()}`, saveToFolder());
        }
      } else {
        updateNodeData(node.id, {
          status: "error",
          error: result.error || "3D generation failed",
        });
        throw new Error(result.error || "3D generation failed");
      }
    } catch (error) {
      if (error instanceof DOMException && error.name === "AbortError") {
        throw error;
      }

      let errorMessage = "3D generation failed";
      if (error instanceof TypeError && error.message.includes("NetworkError")) {
        errorMessage = "Network error. Check your connection and try again.";
      } else if (error instanceof TypeError) {
        errorMessage = `Network error: ${error.message}`;
      } else if (error instanceof Error) {
        errorMessage = error.message;
      }

      updateNodeData(node.id, {
        status: "error",
        error: errorMessage,
      });
      throw new Error(errorMessage);
    }
  };

  // Synthesize a SelectedModel for the primary if selectedModel is missing.
  const primaryModel: SelectedModel = nodeData.selectedModel ?? {
    provider: "fal",
    modelId: "",
    displayName: "",
  };

  if (!primaryModel.modelId) {
    updateNodeData(node.id, { status: "error", error: "No model selected" });
    throw new Error("No model selected");
  }

  await runWithFallback({
    nodeId: node.id,
    primary: primaryModel,
    fallback: nodeData.fallbackModel,
    fallbackParameters: nodeData.fallbackParameters,
    updateNodeData,
    runOnce,
    clearOutput: { output3dUrl: null, savedFilename: null, savedFilePath: null },
  });
}
