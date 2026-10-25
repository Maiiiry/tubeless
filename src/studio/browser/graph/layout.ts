/** One graph node with its rendered box size. */
export interface DagNode {
  readonly id: string;
  readonly width: number;
  readonly height: number;
}

/** A dependency drawn from `from` (upper layer) to `to` (lower layer). */
export interface DagEdge {
  readonly from: string;
  readonly to: string;
}

export interface PlacedDagNode extends DagNode {
  readonly x: number;
  readonly y: number;
  readonly layer: number;
}

export interface DagLayout {
  readonly nodes: ReadonlyMap<string, PlacedDagNode>;
  readonly width: number;
  readonly height: number;
}

export interface DagSpacing {
  readonly columnGap: number;
  readonly rowGap: number;
}

const ORDERING_SWEEPS = 4;

function sortByBarycenter(
  layer: string[],
  neighbors: ReadonlyMap<string, readonly string[]>,
  positions: Map<string, number>
): void {
  const keys = new Map(
    layer.map((id, index) => {
      const placed = neighbors.get(id)!.filter((neighbor) => positions.has(neighbor));
      const key = placed.length
        ? placed.reduce((sum, neighbor) => sum + positions.get(neighbor)!, 0) / placed.length
        : index;
      return [id, key] as const;
    })
  );
  layer.sort((left, right) => keys.get(left)! - keys.get(right)!);
  layer.forEach((id, index) => positions.set(id, index));
}

/**
 * Place a directed acyclic graph top to bottom. Each node sits one layer below its
 * deepest dependency; layers are ordered by neighbor barycenters to reduce crossings
 * and centered horizontally. Self, duplicate and dangling edges are ignored; a cycle
 * edge is treated as absent.
 */
export function layoutDag(
  nodes: readonly DagNode[],
  edges: readonly DagEdge[],
  spacing: DagSpacing
): DagLayout {
  const byId = new Map(nodes.map((node) => [node.id, node]));
  const parents = new Map<string, string[]>(nodes.map((node) => [node.id, []]));
  const children = new Map<string, string[]>(nodes.map((node) => [node.id, []]));
  for (const { from, to } of edges) {
    if (from === to || !byId.has(from) || !byId.has(to)) continue;
    if (parents.get(to)!.includes(from)) continue;
    parents.get(to)!.push(from);
    children.get(from)!.push(to);
  }

  const layerById = new Map<string, number>();
  const visiting = new Set<string>();
  const layerOf = (id: string): number => {
    const known = layerById.get(id);
    if (known !== undefined) return known;
    if (visiting.has(id)) return -1;
    visiting.add(id);
    let layer = 0;
    for (const parent of parents.get(id)!) layer = Math.max(layer, layerOf(parent) + 1);
    visiting.delete(id);
    layerById.set(id, layer);
    return layer;
  };
  const layers: string[][] = [];
  for (const node of nodes) (layers[layerOf(node.id)] ??= []).push(node.id);

  const positions = new Map<string, number>();
  layers[0]?.forEach((id, index) => positions.set(id, index));
  for (let sweep = 0; sweep < ORDERING_SWEEPS; sweep += 1) {
    for (const layer of layers.slice(1)) sortByBarycenter(layer, parents, positions);
    for (const layer of layers.slice(0, -1).reverse()) {
      sortByBarycenter(layer, children, positions);
    }
  }

  const rowWidth = (layer: readonly string[]) =>
    layer.reduce((sum, id) => sum + byId.get(id)!.width, 0) +
    Math.max(0, layer.length - 1) * spacing.columnGap;
  const width = Math.max(0, ...layers.map(rowWidth));
  const placed = new Map<string, PlacedDagNode>();
  let y = 0;
  layers.forEach((layer, index) => {
    let x = (width - rowWidth(layer)) / 2;
    let rowHeight = 0;
    for (const id of layer) {
      const node = byId.get(id)!;
      placed.set(id, { ...node, x, y, layer: index });
      x += node.width + spacing.columnGap;
      rowHeight = Math.max(rowHeight, node.height);
    }
    y += rowHeight + spacing.rowGap;
  });
  return { nodes: placed, width, height: Math.max(0, y - spacing.rowGap) };
}
