import { Type } from "@google/genai";

export const DIAGRAM_RESPONSE_SCHEMA = {
  type: Type.OBJECT,
  properties: {
    title: { type: Type.STRING },
    nodes: {
      type: Type.ARRAY,
      items: {
        type: Type.OBJECT,
        properties: {
          id: { type: Type.STRING },
          position: {
            type: Type.OBJECT,
            properties: { x: { type: Type.NUMBER }, y: { type: Type.NUMBER } },
            required: ["x", "y"],
            propertyOrdering: ["x", "y"],
          },
          type: { type: Type.STRING, enum: ["databaseSchema"] },
          data: {
            type: Type.OBJECT,
            properties: {
              label: { type: Type.STRING },
              schema: {
                type: Type.ARRAY,
                items: {
                  type: Type.OBJECT,
                  properties: {
                    id: { type: Type.STRING },
                    title: { type: Type.STRING },
                    type: { type: Type.STRING },
                    key: { type: Type.STRING, enum: ["PK", "FK"] },
                  },
                  required: ["id", "title", "type"],
                  propertyOrdering: ["id", "title", "type", "key"],
                },
              },
            },
            required: ["label", "schema"],
            propertyOrdering: ["label", "schema"],
          },
        },
        required: ["id", "position", "type", "data"],
        propertyOrdering: ["id", "position", "type", "data"],
      },
    },
    edges: {
      type: Type.ARRAY,
      items: {
        type: Type.OBJECT,
        properties: {
          id: { type: Type.STRING },
          source: { type: Type.STRING },
          target: { type: Type.STRING },
          sourceHandle: { type: Type.STRING },
          targetHandle: { type: Type.STRING },
          type: { type: Type.STRING, enum: ["superCurvyEdge"] },
          markerStart: {
            type: Type.STRING,
            enum: [
              "one-start",
              "many-start",
              "zero-to-one-start",
              "zero-to-many-start",
              "zero-start",
            ],
          },
          markerEnd: {
            type: Type.STRING,
            enum: ["one-end", "many-end", "zero-to-one-end", "zero-to-many-end", "zero-end"],
          },
          // data must exist; allow empty via at-least-one optional prop
          data: {
            type: Type.OBJECT,
            properties: {
              meta: { type: Type.STRING },
            },
          },
        },
        required: [
          "id",
          "source",
          "target",
          "sourceHandle",
          "targetHandle",
          "type",
          "markerStart",
          "markerEnd",
          "data",
        ],
        propertyOrdering: [
          "id",
          "source",
          "target",
          "sourceHandle",
          "targetHandle",
          "type",
          "markerStart",
          "markerEnd",
          "data",
        ],
      },
    },
  },
  required: ["nodes", "edges"],
  propertyOrdering: ["title", "nodes", "edges"],
} as const;
