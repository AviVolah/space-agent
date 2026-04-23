import { readCodexStatus } from "../lib/utils/codex_app_server.js";

export async function get(context) {
  const refreshValue = context.query?.refreshToken;
  const refreshToken =
    refreshValue === true ||
    refreshValue === "true" ||
    refreshValue === "1";

  return {
    body: await readCodexStatus({
      refreshToken
    }),
    status: 200
  };
}
