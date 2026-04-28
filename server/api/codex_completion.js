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

  let stream;

  try {
    stream = await createCodexCompletionStream({
      messages,
      model,
      reasoningEffort,
      systemPrompt
    });
  } catch (error) {
    const completionError = new Error(error?.message || "Codex completion failed before streaming started.");
    completionError.statusCode = 400;
    completionError.cause = error;
    throw completionError;
  }

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
