// @ts-check
// The Pal chat's live reply (MEM-139): POST /chat with the message and prior turns, resolve the text.

/**
 * @param {(url: string, init: RequestInit) => Promise<any>} fetchFn
 * @returns {(text: string, history: {role: string, content: string}[]) => Promise<string>}
 */
export function createPalReply(fetchFn) {
  return async (text, history) => {
    const res = await fetchFn("/chat", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ message: text, history }),
    });
    if (!res.ok) throw new Error(`chat failed: ${res.status}`);
    const body = await res.json();
    const reply = body && typeof body.text === "string" ? body.text : "";
    if (!reply.trim()) throw new Error("chat reply blank");
    return reply;
  };
}
