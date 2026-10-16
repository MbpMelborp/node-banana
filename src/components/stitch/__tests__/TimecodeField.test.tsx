import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { TimecodeField } from "../TimecodeField";

function setup(value = 0.8) {
  const onCommit = vi.fn();
  render(<TimecodeField label="In" value={value} onCommit={onCommit} />);
  const field = screen.getByRole("textbox", { name: "In" }) as HTMLInputElement;
  return { field, onCommit };
}

describe("TimecodeField", () => {
  it("shows the value as m:ss.cc", () => {
    expect(setup(4.6).field.value).toBe("0:04.60");
  });

  it("commits a typed time on Enter", () => {
    const { field, onCommit } = setup();
    field.focus();
    fireEvent.focus(field);
    fireEvent.change(field, { target: { value: "0:01.00" } });
    fireEvent.keyDown(field, { key: "Enter" });
    expect(onCommit).toHaveBeenCalledTimes(1);
    expect(onCommit).toHaveBeenCalledWith(1);
  });

  it("commits on blur", () => {
    const { field, onCommit } = setup();
    fireEvent.focus(field);
    fireEvent.change(field, { target: { value: "2.5" } });
    fireEvent.blur(field);
    expect(onCommit).toHaveBeenCalledWith(2.5);
  });

  it("reverts on Escape without committing, and keeps the key from the editor", () => {
    const { field, onCommit } = setup();
    const outer = vi.fn();
    window.addEventListener("keydown", outer);
    field.focus();
    fireEvent.focus(field);
    fireEvent.change(field, { target: { value: "3" } });
    fireEvent.keyDown(field, { key: "Escape" });
    fireEvent.blur(field);
    window.removeEventListener("keydown", outer);
    expect(onCommit).not.toHaveBeenCalled();
    expect(outer).not.toHaveBeenCalled();
    expect(field.value).toBe("0:00.80");
  });

  it("reverts text that is not a time", () => {
    const { field, onCommit } = setup();
    fireEvent.focus(field);
    fireEvent.change(field, { target: { value: "soon" } });
    fireEvent.blur(field);
    expect(onCommit).not.toHaveBeenCalled();
    expect(field.value).toBe("0:00.80");
  });

  it("commits nothing when focused and left, or given Enter, without typing", () => {
    const { field, onCommit } = setup(1.23456);
    fireEvent.focus(field);
    fireEvent.blur(field);
    fireEvent.focus(field);
    fireEvent.keyDown(field, { key: "Enter" });
    fireEvent.blur(field);
    expect(onCommit).not.toHaveBeenCalled();
    expect(field.value).toBe("0:01.23");
  });

  it("hands focus to the dialog panel on Enter and Escape, not to <body>", () => {
    const onCommit = vi.fn();
    render(
      <div role="dialog" tabIndex={-1} aria-label="Panel">
        <TimecodeField label="In" value={1} onCommit={onCommit} />
      </div>,
    );
    const panel = screen.getByRole("dialog", { name: "Panel" });
    const field = screen.getByRole("textbox", { name: "In" }) as HTMLInputElement;
    field.focus();
    fireEvent.change(field, { target: { value: "2" } });
    fireEvent.keyDown(field, { key: "Enter" });
    expect(onCommit).toHaveBeenCalledWith(2);
    expect(document.activeElement).toBe(panel);
    field.focus();
    fireEvent.keyDown(field, { key: "Escape" });
    expect(document.activeElement).toBe(panel);
    expect(onCommit).toHaveBeenCalledTimes(1);
  });
});
