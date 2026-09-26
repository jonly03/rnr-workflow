import "@testing-library/jest-dom/vitest";
import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { App } from "./App";

vi.stubGlobal("fetch", vi.fn(async () => ({
  ok: true,
  json: async () => []
})));

describe("R&R Case Core staff shell", () => {
  it("renders the Case Queue and New Case action", async () => {
    render(<App />);
    expect(await screen.findByRole("heading", { name: "Case Queue" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /New Case/i })).toBeInTheDocument();
  });
});
