import { describe, expect, it } from "vitest";
import { closestMatches, didYouMean } from "./suggest.js";

const COMMANDS = ["list", "validate", "inspect", "plan", "graph", "run", "history", "ui"];

describe("closestMatches", () => {
  it("catches transpositions, omissions, and insertions", () => {
    expect(closestMatches("lsit", COMMANDS)).toEqual(["list"]);
    expect(closestMatches("histroy", COMMANDS)).toEqual(["history"]);
    expect(closestMatches("inspct", COMMANDS)).toEqual(["inspect"]);
    expect(closestMatches("graphs", COMMANDS)).toEqual(["graph"]);
  });

  it("rejects candidates beyond a third of the longer string", () => {
    // "xyz" vs "run": distance 3, allowance 1.
    expect(closestMatches("xyz", COMMANDS)).toEqual([]);
    // "source" vs "sourc": distance 1, allowance 2.
    expect(closestMatches("sourc", ["source", "target"])).toEqual(["source"]);
    // Two edits in six characters is the boundary.
    expect(closestMatches("srouxe", ["source"])).toEqual([]);
    expect(closestMatches("sourxe", ["source"])).toEqual(["source"]);
  });

  it("ranks near-misses before prefix completions and keeps candidate order on ties", () => {
    expect(
      closestMatches("validated", ["validated-import", "validate", "validated-export"])
    ).toEqual(["validate", "validated-import", "validated-export"]);
    expect(closestMatches("va", ["validate"])).toEqual([]);
  });

  it("ignores case, duplicates, and exact matches", () => {
    expect(closestMatches("LIST", ["list", "list"])).toEqual(["list"]);
    expect(closestMatches("list", ["list", "lint"])).toEqual(["lint"]);
  });

  it("caps the number of suggestions", () => {
    expect(closestMatches("ab", ["aa", "bb", "ac", "ad"], 2)).toEqual(["aa", "bb"]);
  });
});

describe("didYouMean", () => {
  it("formats one or several candidates and returns undefined when none are close", () => {
    expect(didYouMean("lsit", COMMANDS)).toBe('Did you mean "list"?');
    expect(didYouMean("rn", ["run", "ran"], (value) => `--${value}`)).toBe(
      "Did you mean --run or --ran?"
    );
    expect(didYouMean("ab", ["aa", "bb", "ac"])).toBe('Did you mean "aa", "bb" or "ac"?');
    expect(didYouMean("zzz", COMMANDS)).toBeUndefined();
  });
});
