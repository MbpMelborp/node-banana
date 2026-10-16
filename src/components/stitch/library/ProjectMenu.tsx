"use client";

import { useMemo } from "react";
import type { AssetFacets } from "@/lib/assets/types";
import { RadioMenu, type RadioMenuOption } from "./RadioMenu";

const MENU_WIDTH = 220;
const ALL_PROJECTS = "All projects";

/**
 * "All projects ▾": all of them, or one of the projects that hold assets
 * (the library's facets, as the Assets rail lists them), with "Not in a
 * project" last. The filter value is the project's folder, "" for not in a
 * project, null for all.
 */
export function ProjectMenu({
  value,
  projects,
  onChange,
}: {
  value: string | null;
  projects: AssetFacets["projects"];
  onChange: (project: string | null) => void;
}) {
  const options = useMemo<RadioMenuOption<string | null>[]>(
    () => [{ value: null, label: ALL_PROJECTS }, ...projects.map((p) => ({ value: p.path ?? "", label: p.name }))],
    [projects],
  );
  // A project chosen before the facets arrive still names itself
  const current = options.find((o) => o.value === value)?.label ?? (value === "" ? "Not in a project" : ALL_PROJECTS);
  return (
    <RadioMenu
      label={`Project: ${current}`}
      buttonLabel={<span className="min-w-0 max-w-[160px] truncate">{current}</span>}
      value={value}
      options={options}
      onChange={onChange}
      width={MENU_WIDTH}
      // The one toolbar item that gives way: a long project name truncates before the row runs out
      className="min-w-0 shrink border border-card-border px-2.5 text-neutral-200 hover:bg-white/[0.03]"
    />
  );
}
