import { describe, expect, it } from "vitest";
import { layoutDag, type DagEdge, type DagNode } from "./layout.js";

const spacing = { columnGap: 10, rowGap: 20 };

function nodes(...ids: string[]): DagNode[] {
  return ids.map((id) => ({ id, width: 40, height: 30 }));
}

function edges(...pairs: string[]): DagEdge[] {
  return pairs.map((pair) => {
    const [from, to] = pair.split(">");
    return { from: from!, to: to! };
  });
}

describe("layoutDag", () => {
  it("places every node one layer below its deepest dependency without overlaps", () => {
    const layout = layoutDag(
      nodes("a", "b", "c", "d"),
      edges("a>b", "a>c", "b>c", "c>d", "a>d"),
      spacing
    );
    const layer = (id: string) => layout.nodes.get(id)!.layer;
    expect(["a", "b", "c", "d"].map(layer)).toEqual([0, 1, 2, 3]);
    expect(layout.nodes.get("d")!.y).toBe(3 * (30 + 20));
    expect(layout.height).toBe(4 * 30 + 3 * 20);
  });

  it("separates siblings in a layer and centers narrower layers", () => {
    const layout = layoutDag(
      [...nodes("root", "left", "right"), { id: "wide", width: 200, height: 50 }],
      edges("root>left", "root>right"),
      spacing
    );
    const left = layout.nodes.get("left")!;
    const right = layout.nodes.get("right")!;
    expect(left.y).toBe(right.y);
    expect(Math.abs(left.x - right.x)).toBeGreaterThanOrEqual(40 + 10);
    // `wide` has no dependencies, so it shares the first layer with `root`.
    expect(layout.width).toBe(200 + 10 + 40);
    expect(layout.nodes.get("root")!.height).toBe(30);
    expect(layout.nodes.get("left")!.y).toBe(50 + 20);
  });

  it("orders a layer by its parents to avoid crossing edges", () => {
    const layout = layoutDag(
      nodes("a", "b", "fromB", "fromA"),
      edges("a>fromA", "b>fromB"),
      spacing
    );
    const x = (id: string) => layout.nodes.get(id)!.x;
    expect(x("a") < x("b")).toBe(true);
    expect(x("fromA") < x("fromB")).toBe(true);
  });

  it("ignores self, duplicate, dangling, and cyclic edges instead of failing", () => {
    const layout = layoutDag(
      nodes("a", "b", "c"),
      edges("a>a", "a>b", "a>b", "missing>c", "b>c", "c>b"),
      spacing
    );
    expect([...layout.nodes.keys()].sort()).toEqual(["a", "b", "c"]);
    expect(layout.nodes.get("a")!.layer).toBe(0);
    for (const node of layout.nodes.values()) {
      expect(node.layer).toBeGreaterThanOrEqual(0);
    }
  });

  it("returns an empty layout for an empty graph", () => {
    expect(layoutDag([], [], spacing)).toEqual({ nodes: new Map(), width: 0, height: 0 });
  });
});
