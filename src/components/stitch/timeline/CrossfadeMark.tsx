"use client";

/** A mark narrower than this is not drawn. */
const MIN_MARK_PX = 2;

function Wedge({ side, width }: { side: "in" | "out"; width: number }) {
  const incoming = side === "in";
  return (
    <svg
      aria-hidden="true"
      data-testid={incoming ? "stitch-crossfade-in" : "stitch-crossfade-out"}
      className={incoming ? "pointer-events-none absolute inset-y-0 left-0" : "pointer-events-none absolute inset-y-0 right-0"}
      style={{ width, height: "100%" }}
      viewBox="0 0 1 1"
      preserveAspectRatio="none"
    >
      <polygon points={incoming ? "0,0 1,0 0,1" : "0,0 1,0 1,1"} className="fill-black/40" />
      <line
        x1="0"
        y1={incoming ? 1 : 0}
        x2="1"
        y2={incoming ? 0 : 1}
        className="stroke-neutral-200/70"
        strokeWidth={1}
        vectorEffect="non-scaling-stroke"
      />
    </svg>
  );
}

/**
 * A Stacked clip's overlaps, drawn inside its box over the frames (the box's
 * radius clips them). With Crossfade on, a wedge over the head it fades in
 * on and one over the tail it fades out on: the diagonal is the picture's
 * ramp. With it off, the head the clip above hides is darkened, with no
 * hatch (the hatch means "trimmed away"), and the tail has no mark: the clip
 * is in front there. Same-source cuts have no overlap, so no mark.
 */
export function CrossfadeMarks({
  overlapIn,
  overlapOut,
  pxPerSec,
  crossfade,
  coveredBy,
}: {
  /** Seconds this clip shares with the clip before it and the one after it. */
  overlapIn: number;
  overlapOut: number;
  pxPerSec: number;
  crossfade: boolean;
  /** The clip above, by name ("Clip 1"), for the covered head's title. */
  coveredBy: string | null;
}) {
  const head = overlapIn * pxPerSec;
  const tail = overlapOut * pxPerSec;
  if (!crossfade) {
    if (!(head >= MIN_MARK_PX)) return null;
    return (
      <div
        data-testid="stitch-covered-head"
        title={coveredBy ? `Hidden under ${coveredBy}. Its sound plays.` : undefined}
        className="absolute inset-y-0 left-0 bg-black/50"
        style={{ width: head }}
      />
    );
  }
  return (
    <>
      {head >= MIN_MARK_PX && <Wedge side="in" width={head} />}
      {tail >= MIN_MARK_PX && <Wedge side="out" width={tail} />}
    </>
  );
}
