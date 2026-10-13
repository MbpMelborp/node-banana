"use client";

/**
 * LLMFallbackPopover
 *
 * Small centered modal for selecting a fallback LLM for an llmGenerate node.
 * Persists the selection as a SelectedModel on nodeData.fallbackModel, with
 * "google" mapped to "gemini" as ProviderType (matches how NBP stores LLM
 * provider info so JSON round-trips cleanly).
 */

import { Select } from "@/components/ui/Controls";
import { useState, useEffect } from "react";
import { Dialog, DialogBody, DialogButton, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/Dialog";
import { useWorkflowStore } from "@/store/workflowStore";
import type {
  LLMGenerateNodeData,
  LLMProvider,
  LLMModelType,
  ProviderType,
  SelectedModel,
} from "@/types";

import { LLM_PROVIDER_OPTIONS, defaultLLMModel, llmModelLabel, llmModelOptions } from "@/lib/llm/catalog";
import { useUpdateNodeData } from "./paintMode";

const mapLlmToProviderType = (p: LLMProvider): ProviderType =>
  p === "google" ? "gemini" : p;

const mapProviderTypeToLlm = (p: ProviderType): LLMProvider =>
  p === "gemini" ? "google" : (p as LLMProvider);

interface LLMFallbackPopoverProps {
  nodeId: string;
  onClose: () => void;
}

export function LLMFallbackPopover({ nodeId, onClose }: LLMFallbackPopoverProps) {
  const updateNodeData = useUpdateNodeData();
  const node = useWorkflowStore((s) => s.nodes.find((n) => n.id === nodeId));
  const data = node?.data as LLMGenerateNodeData | undefined;
  const existing = data?.fallbackModel;

  const initialProvider: LLMProvider = existing
    ? mapProviderTypeToLlm(existing.provider)
    : "anthropic";
  const initialModel: LLMModelType = (existing?.modelId as LLMModelType) || defaultLLMModel(initialProvider);

  const [provider, setProvider] = useState<LLMProvider>(initialProvider);
  const [model, setModel] = useState<LLMModelType>(initialModel);

  // A legacy id already saved as the fallback stays selectable until changed.
  const modelOptions = llmModelOptions(provider, existing?.modelId);

  // Ensure model is valid whenever provider changes
  useEffect(() => {
    const valid = modelOptions.some((m) => m.value === model);
    if (!valid) setModel(defaultLLMModel(provider));
  }, [provider, model, modelOptions]);

  const handleSave = () => {
    const label = llmModelLabel(model);
    const fallbackModel: SelectedModel = {
      provider: mapLlmToProviderType(provider),
      modelId: model,
      displayName: label,
    };
    updateNodeData(nodeId, { fallbackModel, fallbackParameters: {} });
    onClose();
  };

  const handleRemove = () => {
    updateNodeData(nodeId, { fallbackModel: undefined, fallbackParameters: undefined });
    onClose();
  };

  return (
    <Dialog open onClose={onClose} size="xs" portal>
      <DialogHeader compact closeButton={false}>
        <DialogTitle compact>Select fallback LLM</DialogTitle>
      </DialogHeader>
      <DialogBody compact>
        <label htmlFor="llm-fallback-provider" className="block text-xs text-neutral-400 mb-1">Provider</label>
        <Select
          id="llm-fallback-provider"
          value={provider}
          options={LLM_PROVIDER_OPTIONS}
          onChange={(next) => setProvider(next as LLMProvider)}
          className="mb-3"
        />

        <label htmlFor="llm-fallback-model" className="block text-xs text-neutral-400 mb-1">Model</label>
        <Select
          id="llm-fallback-model"
          value={model}
          options={modelOptions}
          onChange={(next) => setModel(next as LLMModelType)}
          className="mb-1"
        />

      </DialogBody>
      <DialogFooter compact className="justify-between">
        <DialogButton compact variant="danger" onClick={handleRemove}>
          Remove fallback
        </DialogButton>
        <div className="flex gap-1.5">
          <DialogButton compact variant="ghost" onClick={onClose}>
            Cancel
          </DialogButton>
          <DialogButton compact variant="primary" onClick={handleSave}>
            Save
          </DialogButton>
        </div>
      </DialogFooter>
    </Dialog>
  );
}
