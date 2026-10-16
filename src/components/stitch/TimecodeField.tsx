"use client";

import { useRef, useState, type KeyboardEvent } from "react";
import { formatTimecode, parseTimecode } from "@/lib/stitch/timecode";
import { TIMECODE_WELL } from "./editorStyles";

/**
 * An m:ss.cc well (the rail's In and Out). It shows the value, edits as
 * text while focused, and commits a parsed time on Enter or blur; Escape
 * or text that is not a time puts the value back. Only typed text commits:
 * the display is rounded to hundredths, so focusing and leaving a value such
 * as 1.23456 must not write 1.23. Enter and Escape hand focus to the dialog
 * panel rather than <body>, so Tab stays inside the editor. The editor's
 * keys leave a focused text field alone, so typing "i" or "s" here only
 * types. The caller clamps what it is given.
 */
export function TimecodeField({
  value,
  onCommit,
  label,
  disabled,
}: {
  value: number;
  onCommit: (seconds: number) => void;
  label: string;
  disabled?: boolean;
}) {
  const [text, setText] = useState<string | null>(null);
  // Enter and Escape leave the field; the blur that follows must not commit again
  const settled = useRef(false);
  // What the field showed when it took focus: text still equal to it was not edited
  const shown = useRef("");

  const commit = (raw: string) => {
    if (raw.trim() === shown.current) return;
    const parsed = parseTimecode(raw);
    if (parsed !== null) onCommit(parsed);
  };

  const leave = (input: HTMLInputElement) => {
    settled.current = true;
    const panel = input.closest<HTMLElement>('[role="dialog"]');
    if (panel) panel.focus();
    else input.blur();
  };

  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "Enter") {
      event.preventDefault();
      commit(event.currentTarget.value);
      leave(event.currentTarget);
    } else if (event.key === "Escape") {
      // The value goes back; the editor's Escape does not run
      event.preventDefault();
      event.stopPropagation();
      event.nativeEvent.stopImmediatePropagation();
      leave(event.currentTarget);
    }
  };

  return (
    <input
      type="text"
      inputMode="decimal"
      aria-label={label}
      spellCheck={false}
      autoComplete="off"
      disabled={disabled}
      className={TIMECODE_WELL}
      value={text ?? formatTimecode(value)}
      onFocus={(event) => {
        settled.current = false;
        shown.current = formatTimecode(value);
        setText(shown.current);
        event.currentTarget.select();
      }}
      onChange={(event) => setText(event.target.value)}
      onKeyDown={onKeyDown}
      onBlur={(event) => {
        // Enter and Escape have already settled theirs; commit() skips text nobody typed
        if (text !== null && !settled.current) commit(event.currentTarget.value);
        settled.current = false;
        setText(null);
      }}
    />
  );
}
