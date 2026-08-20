import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { generateProposedCopy } from "./caption";

describe("generateProposedCopy", () => {
  it("returns the exact three-line ORIGIN field-note template", () => {
    const copy = generateProposedCopy({
      title: "A moment in motion",
      creatorName: "DJ Example",
    });

    expect(copy).toEqual({
      proposedTitle: "A moment in motion",
      proposedCaption: [
        "An ORIGIN field note with DJ Example.",
        "Recorded live at Primordial Den.",
        "ORIGIN is a Primordial Groove weekly, held at the Den.",
      ].join("\n"),
    });
    expect(copy.proposedCaption.split("\n")).toHaveLength(3);
    expect(Object.keys(copy).sort()).toEqual(["proposedCaption", "proposedTitle"]);
  });

  it("keeps title handling separate from the caption", () => {
    const fallback = generateProposedCopy({ title: "   ", creatorName: "Artist" });
    const truncated = generateProposedCopy({ title: "x".repeat(160), creatorName: "Artist" });

    expect(fallback.proposedTitle).toBe("ORIGIN session highlight");
    expect(fallback.proposedCaption).toBe(
      [
        "An ORIGIN field note with Artist.",
        "Recorded live at Primordial Den.",
        "ORIGIN is a Primordial Groove weekly, held at the Den.",
      ].join("\n"),
    );
    expect(truncated.proposedTitle).toHaveLength(100);
    expect(truncated.proposedTitle.endsWith("…")).toBe(true);
    expect(truncated.proposedCaption).not.toContain("x".repeat(20));
  });

  it("has no environment or configuration dependency", () => {
    const source = readFileSync(new URL("./caption.ts", import.meta.url), "utf8");

    expect(source).not.toMatch(/@\/lib\/config|process\.env|DEN_BOOKING_URL/);
  });
});
