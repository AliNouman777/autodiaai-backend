type ChatMessage = { role: "user" | "assistant" | "system"; content: string; ts: number };

export function minifyErdForPrompt(doc: any) {
  const nodes = (doc.nodes ?? []).map((n: any) => ({
    id: n.id,
    label: n?.data?.label || n.id,
    schema: (n?.data?.schema ?? []).map((f: any) => ({
      id: f.id,
      title: f.title,
      type: f.type,
      key: f.key,
    })),
  }));
  const edges = (doc.edges ?? []).map((e: any) => ({
    id: e.id,
    source: e.source,
    target: e.target,
    sourceHandle: e.sourceHandle,
    targetHandle: e.targetHandle,
  }));
  return { nodes, edges };
}

export function tailForPrompt(chat: ChatMessage[] = [], n = 6): string[] {
  return chat
    .filter((m) => m?.content?.trim())
    .map((m) => `${m.role.toUpperCase()}: ${m.content.trim()}`)
    .slice(-n);
}

export function composePrompt(existingDoc: any, userPrompt: string, chatTail: string[] = []) {
  const compact = JSON.stringify(minifyErdForPrompt(existingDoc));
  const history = chatTail.slice(-6).join("\n");
  return [
    "You are an ERD assistant.",
    "Return ONLY one of the following JSON shapes:",
    `A) Full ERD: {"nodes":[...], "edges":[...]}`,
    `B) Operations: {"ops":[{"op":"add_field","tableId":"...","id":"...","title":"...","type":"...","key":"NONE|PRIMARY|UNIQUE|FOREIGN"}, {"op":"rename_table","oldId":"...","newId":"...","newLabel?":"..."}]}`,
    "",
    "CURRENT_ERD_JSON:",
    compact,
    "",
    "RECENT_CHAT_SUMMARY:",
    history || "(none)",
    "",
    "USER_REQUEST:",
    userPrompt.trim(),
  ].join("\n");
}
