import { describe, expect, it } from "vitest";
import { humanizeEvent, humanizeStage } from "./job-events";

describe("humanizeStage", () => {
  it("maps known stages to labels", () => {
    expect(humanizeStage("ingest")).toBe("Downloading");
    expect(humanizeStage("signals")).toBe("Analyzing audio & video");
    expect(humanizeStage("crew")).toBe("Finding the best moments");
    expect(humanizeStage("render")).toBe("Rendering clips");
  });

  it("falls back to a titlecased stage name for an unknown stage", () => {
    expect(humanizeStage("mystery")).toBe("Mystery");
  });

  it("falls back to a generic label when there is no stage yet", () => {
    expect(humanizeStage(null)).toBe("Getting started");
  });
});

describe("humanizeEvent", () => {
  it("scout/found with a count in the payload", () => {
    expect(humanizeEvent("scout", "found", { count: 5 })).toBe("Scout found 5 moments");
  });

  it("scout/found with count=1 is singular", () => {
    expect(humanizeEvent("scout", "found", { count: 1 })).toBe("Scout found 1 moment");
  });

  it("scout without a usable count falls back to the scanning message", () => {
    expect(humanizeEvent("scout", "found", {})).toBe("Scout is scanning…");
    expect(humanizeEvent("scout", "found", null)).toBe("Scout is scanning…");
    expect(humanizeEvent("scout", "start", { count: 5 })).toBe("Scout is scanning…");
  });

  it("known agents get their static message regardless of action/payload", () => {
    expect(humanizeEvent("critic", "score", { anything: true })).toBe("Critic is scoring candidates");
    expect(humanizeEvent("surgeon", "repair", null)).toBe("Trimming cuts");
    expect(humanizeEvent("hooks", "write", null)).toBe("Writing hooks");
    expect(humanizeEvent("qa", "check", null)).toBe("Quality checks");
  });

  it("unknown agent falls back to a titlecased name without crashing", () => {
    expect(humanizeEvent("orchestrator", "start", null)).toBe("Orchestrator");
    expect(humanizeEvent("mystery-agent", "whatever", { count: 3 })).toBe("Mystery-agent");
  });
});
