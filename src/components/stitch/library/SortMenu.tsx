"use client";

import type { AssetSort } from "@/lib/assets/types";
import { RadioMenu, type RadioMenuOption } from "./RadioMenu";

const MENU_WIDTH = 160;
const SORT_OPTIONS: readonly RadioMenuOption<AssetSort>[] = [
  { value: "newest", label: "Newest first" },
  { value: "oldest", label: "Oldest first" },
];

/** "Newest first ▾", the Assets view's own two orders. */
export function SortMenu({ value, onChange }: { value: AssetSort; onChange: (sort: AssetSort) => void }) {
  const current = SORT_OPTIONS.find((o) => o.value === value)?.label ?? SORT_OPTIONS[0].label;
  return (
    <RadioMenu
      label={`Sort: ${current}`}
      buttonLabel={current}
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
