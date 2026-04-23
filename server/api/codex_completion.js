import { createCodexCompletionStream } from "../lib/utils/codex_app_server.js";

export async function post(context) {
  const body = context.body && typeof context.body === "object" ? context.body : {};
  const messages = Array.isArray(body.messages) ? body.messages : [];
  const model = String(body.model || "").trim();
  const reasoningEffort = String(body.reasoningEffort || "").trim();
  const systemPrompt = String(body.systemPrompt || "").trim();

  if (!messages.length) {
    const error = new Error("Codex completion requires prepared messages.");
    error.statusCode = 400;
    throw error;
  }

  const stream = await createCodexCompletionStream({
    messages,
    model,
    reasoningEffort,
    systemPrompt
  });

  return {
    headers: {
      "Cache-Control": "no-store",
      Connection: "keep-alive",
      "Content-Type": "text/event-stream; charset=utf-8"
    },
    status: 200,
    stream
  };
}
