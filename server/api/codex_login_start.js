import { startCodexLogin } from "../lib/utils/codex_app_server.js";

export async function post() {
  return startCodexLogin();
}
