import { describe, it, expect } from "vitest";
import type { ClipWarp, StitchTimelineClip, WorkflowEdge, WorkflowNode } from "@/types";
import {
  dropRemovedStitchEdges,
  dropStitchEdges,
  dropStitchMusicClips,
  isLegacyStitch,
  legacyClipId,
  migrateStitchTimeline,
  reconcileTimelineWithEdges,
  remapStitchEdgeIds,
  sanitizeTimeline,
  stitchOrderPatch,
  stitchVideoEdgeIds,
} from "../migrate";
import { createAudioClip, MUSIC_CLIP_ID } from "../audioClips";
import { createClip } from "../timeline";
import { sanitizeWarp, splitWarp, warpMap, withWarp } from "../warp";

const edgeClip = (id: string, edgeId: string, init: Partial<StitchTimelineClip> = {}) =>
  createClip({ kind: "edge", edgeId }, { id, ...init });
const assetClip = (id: string, assetId: string) => createClip({ kind: "asset", assetId }, { id });

describe("stitchVideoEdgeIds", () => {
  it("lists the non-loop video edges into the node, in store order", () => {
    const edges = [
      { id: "e2", source: "b", target: "s", targetHandle: "video-1" },
      { id: "m", source: "m", target: "s", targetHandle: "audio" },
      { id: "loop", source: "c", target: "s", targetHandle: "video-2", data: { isLoop: true } },
      { id: "other", source: "a", target: "t", targetHandle: "video-0" },
      { id: "e1", source: "a", target: "s", targetHandle: "video-0" },
    ] as WorkflowEdge[];
    expect(stitchVideoEdgeIds("s", edges)).toEqual(["e2", "e1"]);
  });
});

describe("migrateStitchTimeline (legacy)", () => {
  it("follows clipOrder, drops stale ids and appends unknown live edges in edge order", () => {
    const timeline = migrateStitchTimeline(
      { clipOrder: ["e3", "gone", "e1"] },
      { liveEdgeIds: ["e1", "e2", "e3", "e4"], hasMusic: false },
    );
    expect(timeline.map((c) => c.source)).toEqual([
      { kind: "edge", edgeId: "e3" },
      { kind: "edge", edgeId: "e1" },
      { kind: "edge", edgeId: "e2" },
      { kind: "edge", edgeId: "e4" },
    ]);
    expect(timeline[0]).toEqual({
      id: "clip:e3",
      source: { kind: "edge", edgeId: "e3" },
      inSec: 0,
      outSec: null,
      muted: false,
      volume: 1,
    });
  });

  it("gives the same ids every time", () => {
    const ctx = { liveEdgeIds: ["e1", "e2"], hasMusic: false };
    const ids = (t: StitchTimelineClip[]) => t.map((c) => c.id);
    expect(ids(migrateStitchTimeline({ clipOrder: [] }, ctx))).toEqual(ids(migrateStitchTimeline({ clipOrder: [] }, ctx)));
    expect(legacyClipId("e1")).toBe("clip:e1");
  });

  it("mutes the clips iff music is connected, as today's stitch drops their sound", () => {
    const withMusic = migrateStitchTimeline({ clipOrder: ["e1"] }, { liveEdgeIds: ["e1"], hasMusic: true });
    const without = migrateStitchTimeline({ clipOrder: ["e1"] }, { liveEdgeIds: ["e1"], hasMusic: false });
    expect(withMusic[0].muted).toBe(true);
    expect(without[0].muted).toBe(false);
  });
});

describe("migrateStitchTimeline (timeline present)", () => {
  it("returns the stored timeline sanitised, in its own order, ignoring clipOrder", () => {
    const stored = [assetClip("x", "alibrary00001"), edgeClip("b", "e2", { inSec: 1, volume: 7 }), edgeClip("a", "e1")];
    const timeline = migrateStitchTimeline(
      { clipOrder: ["e1", "e2"], timeline: stored },
      { liveEdgeIds: ["e1", "e2", "e3"], hasMusic: true },
    );
    expect(timeline.map((c) => c.id)).toEqual(["x", "b", "a"]);
    expect(timeline[1]).toMatchObject({ inSec: 1, volume: 1, muted: false });
    expect(isLegacyStitch({ timeline: stored })).toBe(false);
    expect(isLegacyStitch({})).toBe(true);
  });
});

describe("sanitizeTimeline", () => {
  it("returns [] for anything that is not an array", () => {
    expect(sanitizeTimeline(undefined)).toEqual([]);
    expect(sanitizeTimeline({ clips: [] })).toEqual([]);
  });

  it("drops broken entries and coerces the fields", () => {
    const raw = [
      null,
      "clip",
      { id: "", source: { kind: "edge", edgeId: "e1" } },
      { id: "nosource" },
      { id: "badsource", source: { kind: "edge" } },
      { id: "a", source: { kind: "edge", edgeId: "e1", extra: 1 }, inSec: -2, outSec: "x", muted: "yes", volume: Infinity },
      { id: "b", source: { kind: "asset", assetId: "alibrary00001" }, inSec: 3, outSec: 2, muted: true, volume: 0.4 },
      { id: "c", source: { kind: "edge", edgeId: "e2" }, inSec: 1, outSec: 4, volume: -3 },
    ];
    expect(sanitizeTimeline(raw)).toEqual([
      { id: "a", source: { kind: "edge", edgeId: "e1" }, inSec: 0, outSec: null, muted: false, volume: 1 },
      { id: "b", source: { kind: "asset", assetId: "alibrary00001" }, inSec: 3, outSec: null, muted: true, volume: 0.4 },
      { id: "c", source: { kind: "edge", edgeId: "e2" }, inSec: 1, outSec: 4, muted: false, volume: 0 },
    ]);
    expect(sanitizeTimeline(raw).some((clip) => "warp" in clip)).toBe(false);
  });

  it("keeps a finite startSec unrounded, clamped to 0–600, and drops anything else", () => {
    const at = (startSec: unknown) => sanitizeTimeline([{ id: "a", source: { kind: "edge", edgeId: "e1" }, startSec }])[0];
    expect(at(1 / 3).startSec).toBe(1 / 3);
    expect(at(-1).startSec).toBe(0);
    expect(at(700).startSec).toBe(600);
    expect("startSec" in at(Number.NaN)).toBe(false);
    expect("startSec" in at("3")).toBe(false);
    expect("startSec" in at(undefined)).toBe(false);
  });

  it("drops a library clip whose id is not an asset id, so no URL is ever built from it", () => {
    const raw = [
      assetClip("dots", "../browse-directory?purpose="),
      assetClip("slash", "a000000000000/../../env-status"),
      assetClip("upper", "A000000000000"),
      assetClip("ok", "alibrary00001"),
    ];
    expect(sanitizeTimeline(raw).map((c) => c.id)).toEqual(["ok"]);
  });

  it("gives a repeated id a new one, the same on every read", () => {
    const raw = [edgeClip("a", "e1"), edgeClip("a", "e2"), edgeClip("a", "e3")];
    const ids = sanitizeTimeline(raw).map((c) => c.id);
    expect(new Set(ids).size).toBe(3);
    expect(ids[0]).toBe("a");
    expect(sanitizeTimeline(raw).map((c) => c.id)).toEqual(ids);
  });
});

describe("sanitizeTimeline (warps)", () => {
  const W = (speed: number, curve: ClipWarp["curve"] = null, extra: Partial<ClipWarp> = {}): ClipWarp => ({
    speed,
    curve,
    reverse: false,
    blend: false,
    ...extra,
  });
  const ramps: ClipWarp[] = [
    W(2),
    W(0.5, { kind: "preset", name: "easeInOutSine" }, { blend: true }),
    W(1.5, { kind: "bezier", handles: [0.42, 0, 0.58, 1] }, { window: [0.2, 0.7] }),
    W(
      0.8,
      {
        kind: "points",
        points: [
          [0, 0],
          [0.3, 0.1],
          [0.7, 0.8],
          [1, 1],
        ],
      },
      { reverse: true },
    ),
  ];

  it("keeps a warp of each kind, the key last", () => {
    for (const warp of ramps) {
      const [clip] = sanitizeTimeline([{ ...edgeClip("a", "e1", { inSec: 1, outSec: 4 }), warp }]);
      expect(clip.warp).toEqual(warp);
      expect(Object.keys(clip)).toEqual(["id", "source", "inSec", "outSec", "muted", "volume", "warp"]);
      const [placed] = sanitizeTimeline([{ ...edgeClip("a", "e1"), warp, startSec: 2 }]);
      expect(Object.keys(placed)).toEqual(["id", "source", "inSec", "outSec", "muted", "volume", "startSec", "warp"]);
    }
  });

  it("sanitizes a broken warp and drops one that changes nothing", () => {
    const [fast, falling, identity, blendOnly] = sanitizeTimeline([
      { ...edgeClip("a", "e1"), warp: { speed: 1e12, curve: null, reverse: false, blend: false } },
      {
        ...edgeClip("b", "e1"),
        warp: {
          speed: 1,
          curve: { kind: "points", points: [[0, 0], [0.4, 0.8], [0.6, 0.3], [1, 1]] },
          reverse: false,
          blend: false,
        },
      },
      {
        ...edgeClip("c", "e1"),
        warp: { speed: 1, curve: { kind: "preset", name: "linear" }, reverse: false, blend: true },
      },
      { ...edgeClip("d", "e1"), warp: "2x" },
    ]);
    expect(fast.warp!.speed).toBe(1e9);
    expect(falling.warp!.curve).toEqual({ kind: "points", points: [[0, 0], [0.4, 0.8], [0.6, 0.8], [1, 1]] });
    expect("warp" in identity).toBe(false);
    expect("warp" in blendOnly).toBe(false);
  });

  function lcg(seed: number): () => number {
    let s = seed;
    return () => {
      s = (s * 1103515245 + 12345) % 2147483648;
      return s / 2147483648;
    };
  }

  it("is a fixed point: a timeline with warps reads back the same through a file", () => {
    const random = lcg(3);
    const pick = <T,>(options: readonly T[]): T => options[Math.floor(random() * options.length)];
    const names = ["easeInQuad", "easeOutCubic", "easeInOutSine", "easeInExpo", "easeInOutCirc", "linear", "toString"];
    const fuzz = () =>
      sanitizeWarp({
        speed: pick([10 ** (random() * 4 - 2), 1, -1, Number.NaN]),
        curve: pick([
          null,
          { kind: "preset", name: pick(names) },
          { kind: "bezier", handles: [random(), random() * 1.4 - 0.2, random(), random()] },
          { kind: "points", points: Array.from({ length: Math.floor(random() * 6) }, () => [random(), random()]) },
        ]),
        ...(random() < 0.5 ? { window: [random() * 0.5, 0.5 + random() * 0.5] } : {}),
        reverse: random() < 0.5,
        blend: random() < 0.5,
      });
    const piece = () => {
      const whole = fuzz();
      if (!whole) return undefined;
      const range = { inSec: random() * 5, outSec: 5 + random() * 30 };
      const split = splitWarp(range, whole, random() * warpMap(range, whole).length);
      return split ? pick([split.first.warp, split.second.warp]) : whole;
    };
    for (let k = 0; k < 300; k++) {
      const timeline = Array.from({ length: 1 + Math.floor(random() * 5) }, (_, i) => {
        const inSec = Math.floor(random() * 4);
        const clip = createClip(
          { kind: "edge", edgeId: `e${i}` },
          {
            id: `c${i}`,
            inSec,
            outSec: random() < 0.5 ? null : inSec + 1 + random() * 5,
            volume: random(),
            ...(random() < 0.4 ? { startSec: random() * 600 } : {}),
          },
        );
        return withWarp(clip, random() < 0.5 ? fuzz() : piece());
      });
      const read = sanitizeTimeline(JSON.parse(JSON.stringify(timeline)));
      expect(read).toEqual(timeline);
      const text = JSON.stringify(read);
      expect(JSON.stringify(sanitizeTimeline(JSON.parse(text)))).toBe(text);
    }
  });
});

describe("reconcileTimelineWithEdges", () => {
  it("drops every piece of a vanished edge and keeps asset clips in place", () => {
    const timeline = [edgeClip("a", "e1"), assetClip("x", "alibrary00001"), edgeClip("a2", "e1"), edgeClip("b", "e2")];
    const result = reconcileTimelineWithEdges(timeline, ["e2"]);
    expect(result.changed).toBe(true);
    expect(result.timeline.map((c) => c.id)).toEqual(["x", "b"]);
  });

  it("appends new edges in live order, unmuted unless asked", () => {
    const timeline = [edgeClip("b", "e2")];
    const result = reconcileTimelineWithEdges(timeline, ["e3", "e2", "e1"]);
    expect(result.timeline.map((c) => c.id)).toEqual(["b", "clip:e3", "clip:e1"]);
    expect(result.timeline[1].muted).toBe(false);
    expect(reconcileTimelineWithEdges(timeline, ["e2", "e1"], { muteNew: true }).timeline[1].muted).toBe(true);
  });

  it("returns the same array when nothing changes", () => {
    const timeline = [edgeClip("a", "e1"), assetClip("x", "alibrary00001")];
    const result = reconcileTimelineWithEdges(timeline, ["e1"]);
    expect(result.changed).toBe(false);
    expect(result.timeline).toBe(timeline);
  });

  it("falls back to a fresh id when the edge's legacy id is taken", () => {
    const timeline = [createClip({ kind: "asset", assetId: "alibrary00001" }, { id: "clip:e1" })];
    const result = reconcileTimelineWithEdges(timeline, ["e1"]);
    expect(result.timeline[1].id).not.toBe("clip:e1");
    expect(result.timeline[1].id).toMatch(/^clip_/);
  });
});

describe("stitchOrderPatch", () => {
  const timeline = [edgeClip("b", "e2"), assetClip("x", "alibrary00001"), edgeClip("a", "e1")];

  it("writes clipOrder alone for a legacy node", () => {
    expect(stitchOrderPatch({}, timeline)).toEqual({ clipOrder: ["e2", "e1"] });
  });

  it("writes the timeline with clipOrder in sync otherwise", () => {
    expect(stitchOrderPatch({ timeline: [] }, timeline)).toEqual({ timeline, clipOrder: ["e2", "e1"] });
  });
});

describe("remapStitchEdgeIds", () => {
  const map = new Map([["e1", "n1"], ["e2", "n2"]]);

  it("rewrites the timeline's edges and clipOrder, leaving unknown ids alone", () => {
    const data = {
      clipOrder: ["e1", "e2", "e9"],
      timeline: [edgeClip("a", "e1", { inSec: 1 }), assetClip("x", "alibrary00001"), edgeClip("c", "e9")],
    };
    const remapped = remapStitchEdgeIds(data, map);
    expect(remapped.clipOrder).toEqual(["n1", "n2", "e9"]);
    expect(remapped.timeline!.map((c) => c.source)).toEqual([
      { kind: "edge", edgeId: "n1" },
      { kind: "asset", assetId: "alibrary00001" },
      { kind: "edge", edgeId: "e9" },
    ]);
    expect(remapped.timeline![0].inSec).toBe(1);
    expect(data.clipOrder).toEqual(["e1", "e2", "e9"]);
  });

  it("keeps the clips' starts", () => {
    const data = { clipOrder: ["e1"], timeline: [edgeClip("a", "e1", { startSec: 4.5 }), assetClip("x", "alibrary00001")] };
    const remapped = remapStitchEdgeIds(data, map);
    expect(remapped.timeline![0].startSec).toBe(4.5);
    expect(dropStitchEdges(remapped, new Set(["e9"])).timeline![0].startSec).toBe(4.5);
    const placed = { clipOrder: ["e1", "e2"], timeline: [edgeClip("a", "e1"), edgeClip("b", "e2", { startSec: 7 })] };
    expect(dropStitchEdges(placed, new Set(["e1"])).timeline).toEqual([edgeClip("b", "e2", { startSec: 7 })]);
  });

  it("keeps a legacy node legacy", () => {
    const remapped = remapStitchEdgeIds({ clipOrder: ["e1"] }, map);
    expect(remapped).toEqual({ clipOrder: ["n1"] });
    expect("timeline" in remapped).toBe(false);
  });
});

describe("dropStitchEdges", () => {
  it("drops every piece of a removed edge and its clipOrder entry, keeping asset clips and malformed entries", () => {
    const bad = { id: "bad" } as unknown as StitchTimelineClip;
    const data = {
      clipOrder: ["e1", "e2"],
      timeline: [edgeClip("a", "e1"), assetClip("x", "alibrary00002"), edgeClip("a2", "e1"), edgeClip("b", "e2"), bad],
    };
    expect(dropStitchEdges(data, new Set(["e1"]))).toEqual({
      clipOrder: ["e2"],
      timeline: [assetClip("x", "alibrary00002"), edgeClip("b", "e2"), bad],
    });
  });

  it("returns the input when nothing references the edges, and gives a legacy node no timeline", () => {
    const data = { clipOrder: ["e1"], timeline: [edgeClip("a", "e1")] };
    expect(dropStitchEdges(data, new Set(["e9"]))).toBe(data);
    const legacy = dropStitchEdges({ clipOrder: ["e1", "e2"] }, new Set(["e1"]));
    expect(legacy).toEqual({ clipOrder: ["e2"] });
    expect("timeline" in legacy).toBe(false);
  });

  it("touches only the Stitch nodes the removed edges led into", () => {
    const stitch = (id: string) =>
      ({ id, type: "videoStitch", position: { x: 0, y: 0 }, data: { clipOrder: ["e1"] } }) as unknown as WorkflowNode;
    const nodes = [stitch("s1"), stitch("s2")];
    const removed = [{ id: "e1", source: "g", target: "s1" }] as WorkflowEdge[];
    const next = dropRemovedStitchEdges(nodes, removed);
    expect((next[0].data as { clipOrder: string[] }).clipOrder).toEqual([]);
    expect(next[1]).toBe(nodes[1]);
    expect(dropRemovedStitchEdges(nodes, [{ id: "e1", source: "g", target: "other" }] as WorkflowEdge[])).toBe(nodes);
  });
});

describe("dropStitchMusicClips", () => {
  const musicClip = createAudioClip({ kind: "music" }, { id: MUSIC_CLIP_ID, startSec: 1 });
  const tone = createAudioClip({ kind: "asset", assetId: "atone00000001" }, { id: "t", row: 1 });

  it("drops the music clips, compacts the rows and resets the older-build copy", () => {
    const data = { clipOrder: [], audioClips: [musicClip, tone], audioCurve: [{ t: 0, gain: 0.5 }], audioMuted: true };
    expect(dropStitchMusicClips(data)).toEqual({
      clipOrder: [],
      audioClips: [{ ...tone, row: 0 }],
      audioCurve: [],
      audioMuted: false,
    });
  });

  it("removes the key when nothing is left, so the node reads as legacy with fresh music", () => {
    const next = dropStitchMusicClips({ audioClips: [musicClip], audioCurve: [], audioMuted: true });
    expect(next).toEqual({ audioCurve: [], audioMuted: false });
    expect("audioClips" in next).toBe(false);
  });

  it("leaves library clips, empty lists and legacy nodes alone", () => {
    const library = { audioClips: [tone] };
    expect(dropStitchMusicClips(library)).toBe(library);
    const empty = { audioClips: [] };
    expect(dropStitchMusicClips(empty)).toBe(empty);
    const legacy = { audioCurve: [{ t: 1, gain: 0 }], audioMuted: true };
    expect(dropStitchMusicClips(legacy)).toBe(legacy);
  });

  it("runs for a removed non-loop audio edge only, with the video edges' drop in the same node", () => {
    const stitch = (id: string) =>
      ({
        id,
        type: "videoStitch",
        position: { x: 0, y: 0 },
        data: { clipOrder: ["e1"], timeline: [edgeClip("a", "e1")], audioClips: [musicClip, tone] },
      }) as unknown as WorkflowNode;
    const nodes = [stitch("s1")];
    const audio = { id: "m", source: "a", target: "s1", targetHandle: "audio" } as WorkflowEdge;
    const loop = { ...audio, id: "loop", data: { isLoop: true } } as WorkflowEdge;
    const videoEdge = { id: "e1", source: "g", target: "s1", targetHandle: "video-0" } as WorkflowEdge;

    const both = dropRemovedStitchEdges(nodes, [audio, videoEdge])[0].data as Record<string, unknown>;
    expect(both.audioClips).toEqual([{ ...tone, row: 0 }]);
    expect(both.timeline).toEqual([]);
    expect(dropRemovedStitchEdges(nodes, [loop])).toBe(nodes);
    const videoOnly = dropRemovedStitchEdges(nodes, [videoEdge])[0].data as Record<string, unknown>;
    expect(videoOnly.audioClips).toEqual([musicClip, tone]);
  });
});
