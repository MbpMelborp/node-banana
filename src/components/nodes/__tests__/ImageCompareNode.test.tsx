import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, renderHook } from "@testing-library/react";
import type { ReactNode } from "react";
import { useComparePosition } from "../ImageCompareNode";
import { HoldLiveProvider, PaintedNodes } from "../paintMode";
import { useNodeUiStore } from "@/store/nodeUiStore";

const live = ({ children }: { children: ReactNode }) => <HoldLiveProvider hold={() => () => {}}>{children}</HoldLiveProvider>;
const painted = ({ children }: { children: ReactNode }) => <PaintedNodes>{children}</PaintedNodes>;

describe("Image Compare divider position", () => {
  beforeEach(() => { vi.useFakeTimers(); useNodeUiStore.getState().forget(); });
  afterEach(() => { vi.useRealTimers(); useNodeUiStore.getState().forget(); });

  it("leaves the slider uncontrolled on the classic canvas", () => {
    const { result } = renderHook(() => useComparePosition("c1"));
    expect(result.current).toBeNull();
  });

  it("keeps where the live slider rests for the painted copy", () => {
    const liveNode = renderHook(() => useComparePosition("c1"), { wrapper: live });
    act(() => { liveNode.result.current!.onPositionChange!(30); liveNode.result.current!.onPositionChange!(22); });
    expect(useNodeUiStore.getState().byNode.c1).toBeUndefined();
    act(() => { vi.advanceTimersByTime(200); });
    expect(useNodeUiStore.getState().byNode.c1).toEqual({ comparePosition: 22 });

    const copy = renderHook(() => useComparePosition("c1"), { wrapper: painted });
    expect(copy.result.current).toEqual({ position: 22 });
  });

  it("keeps a position still settling when the live node unmounts", () => {
    const liveNode = renderHook(() => useComparePosition("c1"), { wrapper: live });
    act(() => liveNode.result.current!.onPositionChange!(70));
    liveNode.unmount();
    expect(useNodeUiStore.getState().byNode.c1).toEqual({ comparePosition: 70 });
  });
});
