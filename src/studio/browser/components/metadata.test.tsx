import { renderToString } from "preact-render-to-string";
import { describe, expect, it } from "vitest";
import { MetadataDetails, MetadataExplorer, groupMetadataSteps } from "./metadata.js";

const steps = [
  { id: "load", metadata: { owner: "data", domain: "billing", tags: ["pii"] } },
  { id: "plain" },
  { id: "save", metadata: { owner: "data", domain: "storage", tags: ["pii", "write"] } },
];

describe("Studio graph metadata", () => {
  it("searches IDs, tags, and annotations while grouping matches in definition order", () => {
    expect([...groupMetadataSteps(steps, "PII", "owner")]).toEqual([
      ["data", [steps[0], steps[2]]],
    ]);
    expect([...groupMetadataSteps(steps, "", "domain").keys()]).toEqual([
      "billing",
      undefined,
      "storage",
    ]);
    expect([...groupMetadataSteps(steps, "plain", "none").values()]).toEqual([[steps[1]]]);
    expect(groupMetadataSteps(steps, "missing", "none").size).toBe(0);
  });

  it.each(["owner", "domain"] as const)(
    "keeps a literal Unassigned %s separate from missing values",
    (field) => {
      const named = { id: "named", metadata: { [field]: "Unassigned" } };
      const missing = { id: "missing" };
      const alsoMissing = { id: "also-missing", metadata: { tags: ["pii"] } };
      const groups = groupMetadataSteps([named, missing, alsoMissing], "", field);
      expect([...groups]).toEqual([
        ["Unassigned", [named]],
        [undefined, [missing, alsoMissing]],
      ]);
      expect([...groupMetadataSteps([missing, named], "", field).keys()]).toEqual([
        undefined,
        "Unassigned",
      ]);
    }
  );

  it("renders search and grouping controls and escapes annotation contents", () => {
    const html = renderToString(<MetadataExplorer steps={steps} />);
    expect(html).toContain("Search steps and metadata");
    expect(html).toContain("Group steps");
    expect(html).toContain("billing");
    const metadata = renderToString(
      <MetadataDetails metadata={{ annotations: { text: "<script>bad</script>" } }} />
    );
    expect(metadata).not.toContain("<script>");
    expect(metadata).toContain("&lt;script>");
  });
});
