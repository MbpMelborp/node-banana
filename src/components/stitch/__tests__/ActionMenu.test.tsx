import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, within } from "@testing-library/react";
import { useState } from "react";
import { MoreMenu, type ActionMenuEntry } from "../ActionMenu";

const open = () => {
  fireEvent.click(screen.getByRole("button", { name: "More" }));
  return screen.getByRole("menu", { name: "More" });
};

describe("MoreMenu", () => {
  it("with every row off, takes focus itself, so Escape and Tab still close it", () => {
    render(<MoreMenu label="More" entries={[{ kind: "item", label: "Nothing", onSelect: vi.fn(), disabled: true }]} />);
    const trigger = screen.getByRole("button", { name: "More" });
    let menu = open();
    expect(menu).toHaveFocus();
    fireEvent.keyDown(menu, { key: "Escape" });
    expect(screen.queryByRole("menu")).toBeNull();
    expect(trigger).toHaveFocus();
    menu = open();
    fireEvent.keyDown(menu, { key: "Tab" });
    expect(screen.queryByRole("menu")).toBeNull();
    expect(trigger).toHaveFocus();
  });

  it("gives focus back to ⋯ after a pick, unless the pick put it somewhere", () => {
    function Harness() {
      const [field, setField] = useState(false);
      return (
        <>
          <MoreMenu
            label="More"
            entries={[
              { kind: "item", label: "Plain", onSelect: vi.fn() },
              { kind: "item", label: "Field", onSelect: () => setField(true) },
            ]}
          />
          {field && <input aria-label="Field" autoFocus />}
        </>
      );
    }
    render(<Harness />);
    const trigger = screen.getByRole("button", { name: "More" });
    fireEvent.click(within(open()).getByRole("menuitem", { name: "Plain" }));
    expect(screen.queryByRole("menu")).toBeNull();
    expect(trigger).toHaveFocus();
    fireEvent.click(within(open()).getByRole("menuitem", { name: "Field" }));
    expect(screen.getByRole("textbox", { name: "Field" })).toHaveFocus();
  });

  it("moves ↑ ↓ through a group's radios with the menu's rows, and picks one like an item", () => {
    const onSelect = vi.fn();
    const entries: ActionMenuEntry[] = [
      { kind: "item", label: "First", onSelect: vi.fn() },
      {
        kind: "group",
        label: "Count",
        footer: "A note",
        entries: [
          { kind: "radio", label: "One", checked: true, onSelect: vi.fn() },
          { kind: "radio", label: "Two", checked: false, onSelect },
        ],
      },
    ];
    render(<MoreMenu label="More" entries={entries} />);
    const menu = open();
    const group = within(menu).getByRole("group", { name: "Count" });
    expect(group).toHaveAccessibleDescription("A note");
    const [first, one, two] = Array.from(menu.querySelectorAll<HTMLElement>('[role^="menuitem"]'));
    expect(first).toHaveFocus();
    fireEvent.keyDown(first, { key: "ArrowDown" });
    expect(one).toHaveFocus();
    fireEvent.keyDown(one, { key: "ArrowDown" });
    expect(two).toHaveFocus();
    expect(two).toHaveAttribute("aria-checked", "false");
    fireEvent.click(two);
    expect(onSelect).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("menu")).toBeNull();
  });
});
