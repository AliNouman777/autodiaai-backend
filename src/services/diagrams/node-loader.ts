import type { Request } from "express";
import { Types } from "mongoose";
import { DiagramModel, type DiagramDoc } from "../../models/diagram.model";
import { getOwnerFilter } from "./owner";

type Loaded = { diagram: DiagramDoc; node: any };
type NotFound = { error: "Diagram not found" | "Node not found" };

export async function loadDiagramWithNode(
  req: Request,
  diagramId: string,
  nodeId: string,
): Promise<Loaded | NotFound> {
  if (!Types.ObjectId.isValid(diagramId)) return { error: "Diagram not found" };

  const owner = getOwnerFilter(req);
  const diagram = await DiagramModel.findOne({ _id: new Types.ObjectId(diagramId), ...owner });

  if (!diagram) return { error: "Diagram not found" };

  const node: any = (diagram.nodes ?? []).find((n: any) => n?.id === nodeId);
  if (!node) return { error: "Node not found" };

  if (!node.data)
    diagram.set?.(
      "nodes",
      (diagram.nodes as any[]).map((n) =>
        n.id === nodeId ? { ...n, data: { label: "Table", schema: [] } } : n,
      ),
    );
  else if (!Array.isArray(node.data.schema)) node.set?.("data.schema", []);

  return { diagram, node };
}
