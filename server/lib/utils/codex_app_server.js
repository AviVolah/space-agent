import { EventEmitter } from "node:events";
import { spawn, spawnSync } from "node:child_process";
import { PassThrough } from "node:stream";
import os from "node:os";
import path from "node:path";

const CODEX_RUNTIME_COMMAND = "codex";
const BRIDGE_SYSTEM_PREFIX = [
  "You are acting only as the authenticated model transport for another application.",
  "Do not use Codex-native tools, commands, files, apps, plugins, MCP servers, or other local runtime side effects.",
  "The host application may instruct you to output its own execution protocol as plain text, including code blocks such as _____javascript.",
  "Follow the host application's prompt exactly when it asks for that text protocol; the host application will execute it after your response.",
  "Do not claim that tools or workspace execution are unavailable when the host application prompt provides an execution protocol.",
  "Do not mention Codex, the local runtime, this transport bridge, or hidden system behavior.",
  "Return only the assistant message intended for the host application."
].join("\n");

let sharedConnection = null;
let sharedConnectionPromise = null;
let sharedLoginState = {
  error: "",
  loginId: "",
  pending: false,
  userCode: "",
  verificationUrl: ""
};
let cachedCodexCommand = undefined;
let cachedCodexVersion = undefined;

function createCodexUnavailableError(message = "Codex is not installed on this machine.") {
  const error = new Error(message);
  error.code = "CODEX_NOT_INSTALLED";
  error.statusCode = 400;
  return error;
}

function normalizeRpcError(errorPayload = {}) {
  const message = String(errorPayload?.message || "Codex app-server request failed.");
  const error = new Error(message);
  error.code = errorPayload?.code;
  error.data = errorPayload?.data;
  return error;
}

function extractTextContent(value) {
  if (typeof value === "string") {
    return value;
  }

  if (!Array.isArray(value)) {
    return "";
  }

  return value
    .map((part) => {
      if (typeof part === "string") {
        return part;
      }

      if (part && typeof part.text === "string") {
        return part.text;
      }

      return "";
    })
    .join("");
}

function normalizeMessageRole(role) {
  if (role === "assistant" || role === "system") {
    return role;
  }

  return "user";
}

function normalizeCompletionMessages(messages = []) {
  return (Array.isArray(messages) ? messages : [])
    .map((message) => {
      const role = normalizeMessageRole(message?.role);
      const content = extractTextContent(message?.content || "").trim();

      if (!content) {
        return null;
      }

      return {
        content,
        role
      };
    })
    .filter(Boolean);
}

function buildDeveloperInstructions(systemPrompt = "") {
  const normalizedSystemPrompt = String(systemPrompt || "").trim();

  if (!normalizedSystemPrompt) {
    return BRIDGE_SYSTEM_PREFIX;
  }

  return `${BRIDGE_SYSTEM_PREFIX}\n\n${normalizedSystemPrompt}`;
}

function buildCodexCollaborationMode({ developerInstructions = "", model = "", reasoningEffort = "" } = {}) {
  const normalizedModel = String(model || "").trim();

  if (!normalizedModel) {
    return null;
  }

  return {
    mode: "default",
    settings: {
      developer_instructions: String(developerInstructions || "").trim(),
      model: normalizedModel,
      reasoning_effort: String(reasoningEffort || "").trim() || "medium"
    }
  };
}

function toInjectedResponseItem(message) {
  const role = normalizeMessageRole(message?.role);

  if (role === "system") {
    return null;
  }

  const content = String(message?.content || "").trim();

  if (!content) {
    return null;
  }

  return {
    type: "message",
    role,
    content: [
      {
        type: role === "assistant" ? "output_text" : "input_text",
        text: content
      }
    ]
  };
}

function createStreamingDeltaPayload(delta) {
  return JSON.stringify({
    choices: [
      {
        delta: {
          content: delta
        },
        finish_reason: null
      }
    ]
  });
}

function writeSseChunk(stream, data) {
  stream.write(`data: ${data}\n\n`);
}

function createStreamingErrorPayload(message) {
  return JSON.stringify({
    error: {
      message: String(message || "Codex completion stream failed.")
    }
  });
}

function extractRouteTurnId(params = {}) {
  return String(params?.turnId || params?.turn?.id || "").trim();
}

function getCodexThreadCwd() {
  return process.env.TEMP || process.env.TMPDIR || os.tmpdir();
}

function runCodexVersion(command) {
  if (!command) {
    return null;
  }

  const result = spawnSync(command, ["--version"], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"]
  });

  if (result.error || result.status !== 0) {
    return null;
  }

  const versionText = String(result.stdout || "").trim();
  return versionText || null;
}

function listWindowsCodexCandidates() {
  const candidates = ["codex"];
  const localAppData = String(process.env.LOCALAPPDATA || "").trim();

  if (localAppData) {
    candidates.push(path.join(localAppData, "OpenAI", "Codex", "bin", "codex.cmd"));
    candidates.push(path.join(localAppData, "OpenAI", "Codex", "bin", "codex.exe"));
  }

  const whereResult = spawnSync("where.exe", ["codex"], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
    windowsHide: true
  });

  if (!whereResult.error && whereResult.status === 0) {
    for (const line of String(whereResult.stdout || "").split(/\r?\n/)) {
      const candidate = line.trim();

      if (candidate) {
        candidates.push(candidate);
      }
    }
  }

  return [...new Set(candidates)];
}

function listCodexCommandCandidates() {
  if (process.platform === "win32") {
    return listWindowsCodexCandidates();
  }

  return ["codex"];
}

function resolveCodexCommand() {
  if (cachedCodexCommand) {
    return cachedCodexCommand;
  }

  for (const candidate of listCodexCommandCandidates()) {
    const version = runCodexVersion(candidate);

    if (!version) {
      continue;
    }

    cachedCodexCommand = candidate;
    cachedCodexVersion = version;
    return cachedCodexCommand;
  }

  return null;
}

function readCodexVersion() {
  if (cachedCodexVersion) {
    return cachedCodexVersion;
  }

  const command = resolveCodexCommand();

  if (!command) {
    return null;
  }

  const version = runCodexVersion(command);

  if (!version) {
    cachedCodexCommand = undefined;
    cachedCodexVersion = undefined;
    return null;
  }

  cachedCodexVersion = version;
  return cachedCodexVersion;
}

function getCodexCommand() {
  const command = resolveCodexCommand();

  if (!command) {
    return null;
  }

  if (!cachedCodexVersion) {
    cachedCodexVersion = runCodexVersion(command);
  }

  return cachedCodexVersion ? command : null;
}

function isCodexInstalled() {
  return Boolean(readCodexVersion());
}

function killCodexChildProcess(child) {
  if (!child || child.killed) {
    return;
  }

  if (process.platform === "win32" && child.pid !== undefined) {
    try {
      spawnSync("taskkill", ["/pid", String(child.pid), "/T", "/F"], {
        stdio: "ignore",
        windowsHide: true
      });
      return;
    } catch {
      // Fall through to direct kill when taskkill is unavailable.
    }
  }

  child.kill();
}

export class CodexAppServerConnection extends EventEmitter {
  constructor() {
    super();
    this.child = null;
    this.initializePromise = null;
    this.nextRequestId = 1;
    this.pendingRequests = new Map();
    this.stdoutBuffer = "";
    this.closed = false;
  }

  async start() {
    if (this.initializePromise) {
      return this.initializePromise;
    }

    this.initializePromise = this.spawnAndInitialize(resolveCodexCommand() || CODEX_RUNTIME_COMMAND);
    return this.initializePromise;
  }

  async spawnAndInitialize(codexCommand) {
    this.child = spawn(codexCommand, ["app-server"], {
      env: process.env,
      shell: process.platform === "win32",
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true
    });

    this.child.once("error", (error) => {
      this.handleFatalError(error);
    });

    this.child.once("exit", (code, signal) => {
      this.handleClose(code, signal);
    });

    this.child.stdout.setEncoding("utf8");
    this.child.stdout.on("data", (chunk) => {
      this.stdoutBuffer += String(chunk || "");
      let boundary = this.stdoutBuffer.indexOf("\n");

      while (boundary !== -1) {
        const line = this.stdoutBuffer.slice(0, boundary).trim();
        this.stdoutBuffer = this.stdoutBuffer.slice(boundary + 1);

        if (line) {
          this.handleStdoutLine(line);
        }

        boundary = this.stdoutBuffer.indexOf("\n");
      }
    });

    if (this.child.stderr) {
      this.child.stderr.resume();
    }

    await this.callRpc("initialize", {
      capabilities: {
        experimentalApi: true
      },
      clientInfo: {
        name: "space-agent",
        title: "Space Agent",
        version: "0.36.0"
      }
    });
    this.notify("initialized", {});
  }

  handleStdoutLine(line) {
    let payload;

    try {
      payload = JSON.parse(line);
    } catch {
      return;
    }

    if (payload && typeof payload === "object" && "id" in payload) {
      const pendingRequest = this.pendingRequests.get(payload.id);

      if (!pendingRequest) {
        return;
      }

      this.pendingRequests.delete(payload.id);

      if (payload.error) {
        pendingRequest.reject(normalizeRpcError(payload.error));
        return;
      }

      pendingRequest.resolve(payload.result);
      return;
    }

    if (payload && typeof payload === "object" && typeof payload.method === "string") {
      this.emit("notification", payload);
      this.emit(`notification:${payload.method}`, payload.params);
    }
  }

  handleFatalError(error) {
    if (this.closed) {
      return;
    }

    this.closed = true;
    this.initializePromise = null;

    for (const { reject } of this.pendingRequests.values()) {
      reject(error);
    }

    this.pendingRequests.clear();
    this.emit("closed", error);
  }

  handleClose(code, signal) {
    const error =
      code === 0 || this.closed
        ? null
        : new Error(`Codex app-server exited unexpectedly (${code ?? "null"}${signal ? `, ${signal}` : ""}).`);
    this.handleFatalError(error || new Error("Codex app-server connection closed."));
  }

  notify(method, params = {}) {
    if (!this.child?.stdin || this.child.stdin.destroyed) {
      throw new Error("Codex app-server stdin is unavailable.");
    }

    this.child.stdin.write(`${JSON.stringify({ method, params })}\n`);
  }

  callRpc(method, params = {}) {
    if (!this.child?.stdin || this.child.stdin.destroyed) {
      return Promise.reject(new Error("Codex app-server stdin is unavailable."));
    }

    return new Promise((resolve, reject) => {
      const requestId = this.nextRequestId++;

      this.pendingRequests.set(requestId, {
        reject,
        resolve
      });

      try {
        this.child.stdin.write(`${JSON.stringify({ id: requestId, method, params })}\n`);
      } catch (error) {
        this.pendingRequests.delete(requestId);
        reject(error);
      }
    });
  }

  async call(method, params = {}) {
    await this.start();

    return this.callRpc(method, params);
  }

  async dispose() {
    this.closed = true;
    this.initializePromise = null;

    if (this.child && !this.child.killed) {
      killCodexChildProcess(this.child);
    }

    this.child = null;
  }
}

async function getSharedConnection() {
  if (sharedConnection && !sharedConnection.closed) {
    return sharedConnection;
  }

  if (sharedConnectionPromise) {
    return sharedConnectionPromise;
  }

  sharedConnectionPromise = (async () => {
    const connection = new CodexAppServerConnection();
    await connection.start();
    connection.on("notification:account/login/completed", (params = {}) => {
      sharedLoginState = {
        error: params?.success ? "" : String(params?.error || "Codex sign-in failed."),
        loginId: String(params?.loginId || sharedLoginState.loginId || "").trim(),
        pending: false,
        userCode: params?.success ? "" : sharedLoginState.userCode,
        verificationUrl: params?.success ? "" : sharedLoginState.verificationUrl
      };
    });
    connection.on("notification:account/updated", () => {
      sharedLoginState = {
        ...sharedLoginState,
        pending: false,
        userCode: "",
        verificationUrl: ""
      };
    });
    connection.on("closed", () => {
      sharedConnection = null;
      sharedConnectionPromise = null;
    });
    sharedConnection = connection;
    return connection;
  })();

  try {
    return await sharedConnectionPromise;
  } catch (error) {
    sharedConnectionPromise = null;
    sharedConnection = null;
    throw error;
  }
}

function normalizeModelList(result = {}) {
  return Array.isArray(result?.data)
    ? result.data.map((entry) => ({
        defaultReasoningEffort: String(entry?.defaultReasoningEffort || "").trim(),
        description: String(entry?.description || "").trim(),
        displayName: String(entry?.displayName || entry?.id || "").trim(),
        id: String(entry?.id || "").trim(),
        model: String(entry?.model || entry?.id || "").trim()
      }))
    : [];
}

export async function readCodexStatus(options = {}) {
  const version = readCodexVersion() || "";

  try {
    const connection = await getSharedConnection();
    const [accountResult, modelResult] = await Promise.all([
      connection.call("account/read", {
        refreshToken: options.refreshToken === true
      }),
      connection.call("model/list", {})
    ]);
    const account = accountResult?.account || null;
    const authenticated = account?.type === "chatgpt";

    if (authenticated) {
      sharedLoginState = {
        error: "",
        loginId: "",
        pending: false,
        userCode: "",
        verificationUrl: ""
      };
    }

    return {
      account,
      authenticated,
      error: "",
      installed: true,
      loginError: sharedLoginState.error,
      loginPending: sharedLoginState.pending,
      loginUserCode: sharedLoginState.userCode,
      loginVerificationUrl: sharedLoginState.verificationUrl,
      models: normalizeModelList(modelResult),
      ready: authenticated,
      requiresOpenaiAuth: accountResult?.requiresOpenaiAuth !== false,
      runtimeStatus: authenticated ? "ready" : "unauthenticated",
      version
    };
  } catch (error) {
    if (!version) {
      return {
        account: null,
        authenticated: false,
        error: "",
        installed: false,
        loginError: "",
        loginPending: false,
        loginUserCode: "",
        loginVerificationUrl: "",
        models: [],
        ready: false,
        requiresOpenaiAuth: true,
        runtimeStatus: "missing",
        version: ""
      };
    }

    return {
      account: null,
      authenticated: false,
      error: String(error?.message || "Codex desktop is installed, but its local app-server bridge failed."),
      installed: true,
      loginError: sharedLoginState.error,
      loginPending: sharedLoginState.pending,
      loginUserCode: sharedLoginState.userCode,
      loginVerificationUrl: sharedLoginState.verificationUrl,
      models: [],
      ready: false,
      requiresOpenaiAuth: true,
      runtimeStatus: "error",
      version
    };
  }
}

export async function startCodexLogin() {
  const connection = await getSharedConnection();
  const result = await connection.call("account/login/start", {
    type: "chatgptDeviceCode"
  });

  sharedLoginState = {
    error: "",
    loginId: String(result?.loginId || "").trim(),
    pending: true,
    userCode: String(result?.userCode || "").trim(),
    verificationUrl: String(result?.verificationUrl || "").trim()
  };

  return {
    loginId: String(result?.loginId || "").trim(),
    type: String(result?.type || "chatgptDeviceCode").trim(),
    userCode: sharedLoginState.userCode,
    verificationUrl: sharedLoginState.verificationUrl
  };
}

async function createCompletionSession(options = {}) {
  const connection = new CodexAppServerConnection();
  await connection.start();

  const normalizedMessages = normalizeCompletionMessages(options.messages);
  const explicitSystemPrompt = String(options.systemPrompt || "").trim();
  const embeddedSystemPrompt = normalizedMessages
    .filter((message) => message.role === "system")
    .map((message) => message.content)
    .join("\n\n")
    .trim();
  const developerInstructions = buildDeveloperInstructions(explicitSystemPrompt || embeddedSystemPrompt);
  const conversationMessages = normalizedMessages.filter((message) => message.role !== "system");
  const lastMessage = conversationMessages.at(-1);

  if (!lastMessage || lastMessage.role !== "user") {
    await connection.dispose();
    throw new Error("Codex subscription transport requires the final prepared message to be a user message.");
  }

  const threadStartResult = await connection.call("thread/start", {
    approvalPolicy: "never",
    cwd: getCodexThreadCwd(),
    ephemeral: true,
    model: String(options.model || "").trim() || null,
    personality: "none",
    sandbox: "read-only"
  });
  const threadId = String(threadStartResult?.thread?.id || "").trim();

  if (!threadId) {
    await connection.dispose();
    throw new Error("Codex did not return a thread id.");
  }

  const historyItems = conversationMessages
    .slice(0, -1)
    .map((message) => toInjectedResponseItem(message))
    .filter(Boolean);

  if (historyItems.length) {
    await connection.call("thread/inject_items", {
      items: historyItems,
      threadId
    });
  }

  const collaborationMode = buildCodexCollaborationMode({
    developerInstructions,
    model: options.model,
    reasoningEffort: options.reasoningEffort
  });
  const turnStartResult = await connection.call("turn/start", {
    approvalPolicy: "never",
    ...(String(options.reasoningEffort || "").trim()
      ? { effort: String(options.reasoningEffort || "").trim() }
      : {}),
    ...(collaborationMode ? { collaborationMode } : {}),
    input: [
      {
        text_elements: [],
        text: lastMessage.content,
        type: "text"
      }
    ],
    model: String(options.model || "").trim() || null,
    personality: "none",
    summary: "none",
    threadId
  });
  const turnId = String(turnStartResult?.turn?.id || "").trim();

  if (!turnId) {
    await connection.dispose();
    throw new Error("Codex did not return a turn id.");
  }

  return {
    connection,
    threadId,
    turnId
  };
}

export async function createCodexCompletionStream(options = {}) {
  const { connection, turnId } = await createCompletionSession(options);
  const stream = new PassThrough();
  let sawDelta = false;
  let closed = false;

  async function cleanup() {
    if (closed) {
      return;
    }

    closed = true;
    connection.off("notification", handleNotification);
    connection.off("closed", handleClosed);
    await connection.dispose().catch(() => {});
  }

  async function fail(error) {
    if (!stream.destroyed && !stream.writableEnded) {
      writeSseChunk(stream, createStreamingErrorPayload(error?.message || "Codex completion stream failed."));
      writeSseChunk(stream, "[DONE]");
      stream.end();
    }

    await cleanup();
  }

  function handleClosed() {
    void fail(new Error("Codex completion stream closed unexpectedly."));
  }

  function handleNotification(notification = {}) {
    const method = String(notification?.method || "").trim();
    const params = notification?.params || {};
    const notificationTurnId = extractRouteTurnId(params);

    if (notificationTurnId !== turnId) {
      return;
    }

    if (method === "item/agentMessage/delta") {
      const delta = String(params?.delta || "");

      if (!delta) {
        return;
      }

      sawDelta = true;
      writeSseChunk(stream, createStreamingDeltaPayload(delta));
      return;
    }

    if (method === "item/completed" && params?.item?.type === "agentMessage" && !sawDelta) {
      const text = String(params?.item?.text || "");

      if (text) {
        sawDelta = true;
        writeSseChunk(stream, createStreamingDeltaPayload(text));
      }

      return;
    }

    if (method === "turn/completed") {
      const status = String(params?.turn?.status || "").trim();

      if (status !== "completed") {
        void fail(new Error(`Codex turn finished with status ${status || "unknown"}.`));
        return;
      }

      writeSseChunk(stream, "[DONE]");
      stream.end();
      void cleanup();
      return;
    }

    if (method === "turn/aborted") {
      void fail(new Error("Codex turn was aborted before completion."));
      return;
    }

    if (method === "error") {
      const errorMessage = String(params?.error?.message || "").trim() || "Codex app-server reported an error.";
      void fail(new Error(errorMessage));
    }
  }

  connection.on("notification", handleNotification);
  connection.on("closed", handleClosed);
  stream.on("close", () => {
    void cleanup();
  });

  return stream;
}
