import { describe, expect, it } from "vitest";
import {
  formatClaim,
  formatSeconds,
  humanizeComponent,
  humanizeQaCode,
  humanizeRepair,
  humanizeSource,
} from "./format-evidence";

describe("formatSeconds", () => {
  it("formats whole minutes/seconds", () => {
    expect(formatSeconds(0)).toBe("0:00");
    expect(formatSeconds(5)).toBe("0:05");
    expect(formatSeconds(65)).toBe("1:05");
    expect(formatSeconds(600)).toBe("10:00");
  });

  it("rounds fractional seconds", () => {
    expect(formatSeconds(18.75206675)).toBe("0:19");
    expect(formatSeconds(59.4)).toBe("0:59");
  });

  it("clamps negative/non-finite input to 0:00 instead of crashing", () => {
    expect(formatSeconds(-5)).toBe("0:00");
    expect(formatSeconds(NaN)).toBe("0:00");
  });
});

describe("formatClaim", () => {
  it("energy_peak with a numeric sigma value", () => {
    expect(formatClaim({ kind: "energy_peak", t: 12, value: 2.3 })).toBe("Energy spike +2.3σ at 0:12");
  });

  it("energy_peak with a null value omits the sigma instead of crashing", () => {
    expect(formatClaim({ kind: "energy_peak", t: 12, value: null })).toBe("Energy spike at 0:12");
  });

  it("laughter", () => {
    expect(formatClaim({ kind: "laughter", t: 30 })).toBe("Laughter at 0:30");
  });

  it("applause", () => {
    expect(formatClaim({ kind: "applause", t: 45 })).toBe("Applause at 0:45");
  });

  it("rate_surge", () => {
    expect(formatClaim({ kind: "rate_surge", t: 8, value: 1.4 })).toBe("Faster speech at 0:08");
  });

  it("silence", () => {
    expect(formatClaim({ kind: "silence", t: 20 })).toBe("Natural pause at 0:20");
  });

  it("scene_stable", () => {
    expect(formatClaim({ kind: "scene_stable", t: 3 })).toBe("Stable shot at 0:03");
  });

  it("quote with a string value, truncated when long", () => {
    expect(formatClaim({ kind: "quote", t: 10, value: "short one" })).toBe('Quotable: "short one"');
    const long = "a".repeat(80);
    const result = formatClaim({ kind: "quote", t: 10, value: long });
    expect(result.startsWith('Quotable: "')).toBe(true);
    expect(result.length).toBeLessThan(long.length);
    expect(result.endsWith('…"')).toBe(true);
  });

  it("quote with a null/missing value falls back instead of crashing", () => {
    expect(formatClaim({ kind: "quote", t: 10, value: null })).toBe("Quotable moment at 0:10");
    expect(formatClaim({ kind: "quote", t: 10 })).toBe("Quotable moment at 0:10");
  });

  it("unknown kind falls back to '<kind> at <time>' without crashing", () => {
    expect(formatClaim({ kind: "mystery_signal", t: 7 })).toBe("mystery_signal at 0:07");
  });

  it("a string value on a numeric-expecting kind doesn't crash (falls back)", () => {
    expect(formatClaim({ kind: "energy_peak", t: 12, value: "not a number" })).toBe("Energy spike at 0:12");
  });
});

describe("humanizeComponent", () => {
  it("maps the four known components", () => {
    expect(humanizeComponent("hook_strength")).toBe("Hook strength");
    expect(humanizeComponent("payoff")).toBe("Payoff");
    expect(humanizeComponent("emotion")).toBe("Emotion");
    expect(humanizeComponent("quotability")).toBe("Quotability");
  });

  it("title-cases an unknown component instead of showing the raw key", () => {
    expect(humanizeComponent("future_signal")).toBe("Future signal");
  });
});

describe("humanizeSource", () => {
  it("maps known candidate sources", () => {
    expect(humanizeSource("rule_a_energy_rate")).toBe("Found by: energy + speech-rate rule");
    expect(humanizeSource("llm")).toBe("Found by: AI semantic pass");
    expect(humanizeSource("fallback")).toBe("Padding (low-signal content)");
  });

  it("falls back to a generic 'Found by' for an unknown source", () => {
    expect(humanizeSource("rule_b_new")).toBe("Found by: rule_b_new");
  });
});

describe("humanizeRepair", () => {
  it("formats a fixed repair", () => {
    expect(humanizeRepair({ attempt: 1, codes: ["ALIGN"], route: "surgeon", outcome: "fixed" })).toBe(
      "Attempt 1: fixed ALIGN via re-cut",
    );
  });

  it("formats a failed repair with multiple codes and a render route", () => {
    expect(
      humanizeRepair({ attempt: 2, codes: ["BLACK", "FROZEN"], route: "render", outcome: "failed" }),
    ).toBe("Attempt 2: attempted to fix BLACK, FROZEN via re-render");
  });

  it("degrades gracefully on a malformed/empty repair entry instead of crashing", () => {
    expect(humanizeRepair({})).toBe("Attempt ?: attempted to fix an issue via unknown step");
    expect(humanizeRepair({ attempt: "one", codes: "ALIGN", route: 7, outcome: 9 })).toBe(
      "Attempt ?: attempted to fix an issue via unknown step",
    );
  });
});

describe("humanizeQaCode", () => {
  it("maps known QA failure codes", () => {
    expect(humanizeQaCode("BLACK")).toBe("Black frame detected");
    expect(humanizeQaCode("ALIGN")).toBe("Caption alignment issue");
    expect(humanizeQaCode("RES")).toBe("Wrong resolution");
    expect(humanizeQaCode("LUFS")).toBe("Audio loudness off-target");
    expect(humanizeQaCode("FROZEN")).toBe("Frozen frame detected");
    expect(humanizeQaCode("WORD_CLIP")).toBe("Clipped word at the cut");
    expect(humanizeQaCode("DUR")).toBe("Clip duration out of range");
    expect(humanizeQaCode("SAFE_AREA")).toBe("Caption overflowed safe area");
  });

  it("falls back to the raw code for an unknown one", () => {
    expect(humanizeQaCode("MYSTERY")).toBe("MYSTERY");
  });
});
