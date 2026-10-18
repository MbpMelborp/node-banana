"use client";

import { useEffect, useRef, useState } from "react";
import type { SourceKey } from "@/lib/stitch/timeline";
import { useStitchEditorStore } from "@/store/stitchEditorStore";
import { EditorRail } from "./EditorRail";
import { EditorStage } from "./EditorStage";
import { EditorTransport } from "./EditorTransport";
import { Timeline } from "./timeline/Timeline";
import type { EditorComposition } from "./useEditorComposition";

/**
 * The editor's body under its header: the stage with its control row under
 * the video, the rail beside them, both on the pane colour, and the timeline
 * across the bottom. The node's dialog and the Edit video view each lay it
 * out in their own column, with the composition they read once for it and
 * their header.
 *
 * The timeline's height follows the layout (Track | Stacked), and the stage
 * gives or takes the difference, which would move the control row. While
 * the pointer is over that row the timeline keeps the height it had as the
 * pointer came in, so a switch never moves the toggle from under it; it
 * settles once the pointer leaves.
 */
export function EditorWorkspace({ composition }: { composition: EditorComposition }) {
  const { byClip, audioByClip, spans, total, empty, stacked, zoom } = composition;
  const timelineHeight = useRef(0);
  const [heldHeight, setHeldHeight] = useState<number | null>(null);

  // An edit that pins a lined-up stack waits for these (clipsLoading)
  useEffect(() => {
    const loading = new Set<SourceKey>();
    for (const view of byClip.values()) if (view.status === "loading") loading.add(view.key);
    useStitchEditorStore.getState().setClipsLoading(loading);
  }, [byClip]);

  return (
    <>
      <div className="flex min-h-0 flex-1 bg-pane">
        <EditorStage
          empty={empty}
          aspect={composition.aspect}
          layers={composition.videoLayers}
          stacked={stacked}
          activeSrc={composition.activeSrc}
          registerVideo={composition.registerVideo}
          audioLayers={composition.audioLayers}
          registerAudio={composition.registerAudio}
        >
          <div
            onPointerEnter={() => setHeldHeight(timelineHeight.current > 0 ? timelineHeight.current : null)}
            onPointerLeave={() => setHeldHeight(null)}
          >
            <EditorTransport
              total={total}
              empty={empty}
              zoom={zoom}
              media={byClip}
              spans={spans}
              frameSize={composition.frameSize}
            />
          </div>
        </EditorStage>
        <EditorRail media={byClip} audio={audioByClip} />
      </div>
      <Timeline
        spans={spans}
        media={byClip}
        audio={audioByClip}
        zoom={zoom}
        srcFor={composition.srcFor}
        stacked={stacked}
        maxHeight={composition.maxTimeline}
        heldHeight={heldHeight}
        heightRef={timelineHeight}
      />
    </>
  );
}
