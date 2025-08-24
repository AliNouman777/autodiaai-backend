// src/schemas/erd.ts
export type TErd = {
  nodes: {
    id: string;
    data: {
      label: string;
      schema: {
        title: string;
        type?: string;
        key?: "PK" | "FK" | string;
      }[];
    };
  }[];
  edges: {
    sourceHandle?: string;
    targetHandle?: string;
  }[];
};
