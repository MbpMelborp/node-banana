"use client";

import type { AssetSort } from "@/lib/assets/types";
import { RadioMenu, type RadioMenuOption } from "./RadioMenu";

const MENU_WIDTH = 160;
const SORT_OPTIONS: readonly RadioMenuOption<AssetSort>[] = [
  { value: "newest", label: "Newest first" },
  { value: "oldest", label: "Oldest first" },
];
const SHORT_LABELS: Record<AssetSort, string> = { newest: "Newest", oldest: "Oldest" };

/** "Newest first ▾", the Assets view's own two orders; `short` shows "Newest ▾" where the row is narrow. */
export function SortMenu({
  value,
  onChange,
  short = false,
}: {
  value: AssetSort;
  onChange: (sort: AssetSort) => void;
  short?: boolean;
}) {
  const option = SORT_OPTIONS.find((o) => o.value === value) ?? SORT_OPTIONS[0];
  const current = option.label;
  return (
    <RadioMenu
      label={`Sort: ${current}`}
      buttonLabel={short ? SHORT_LABELS[option.value] : current}
      value={value}
      options={SORT_OPTIONS}
      onChange={onChange}
      width={MENU_WIDTH}
      align="end"
      className="pl-2 pr-1 text-neutral-400 hover:text-neutral-100"
      chevronClassName=""
    />
  );
}
