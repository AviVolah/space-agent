import { EventEmitter } from "node:events";
import { spawn, spawnSync } from "node:child_process";
import { PassThrough } from "node:stream";
import os from "node:os";

const CODEX_COMMAND = "codex";
const BRIDGE_SYSTEM_PREFIX = [
  "You are acting only as the authenticated model transport for another application.",
  "Do not use tools, commands, files, apps, plugins, MCP servers, or any other side effects.",
  "Do not mention Codex, the local runtime, or hidden system behavior.",
  "Return only the final assistant response text."
].join("\n");

let sharedConnection = null;
let sharedConnectionPromise = null;
let sharedLoginState = {
  error: "",
  loginId: "",
  pending: false
};
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

function getCodexThreadCwd() {
  return process.env.TEMP || process.env.TMPDIR || os.tmpdir();
}

function readCodexVersion() {
  if (cachedCodexVersion !== undefined) {
    return cachedCodexVersion;
  }

  const result = spawnSync(CODEX_COMMAND, ["--version"], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"]
  });

  if (result.error || result.status !== 0) {
    cachedCodexVersion = null;
    return cachedCodexVersion;
  }

  const versionText = String(result.stdout || "").trim();
  cachedCodexVersion = versionText || null;
  return cachedCodexVersion;
}

function isCodexInstalled() {
  return Boolean(readCodexVersion());
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

    if (!isCodexInstalled()) {
      throw createCodexUnavailableError();
    }

    this.initializePromise = this.spawnAndInitialize();
    return this.initializePromise;
  }

  async spawnAndInitialize() {
    this.child = spawn(CODEX_COMMAND, ["app-server"], {
      env: process.env,
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

    await this.call("initialize", {
      capabilities: {},
      clientInfo: {
        name: "space-agent",
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

  async call(method, params = {}) {
    await this.start();

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

  async dispose() {
    this.closed = true;
    this.initializePromise = null;

    if (this.child && !this.child.killed) {
      this.child.kill();
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
        pending: false
      };
    });
    connection.on("notification:account/updated", () => {
      sharedLoginState = {
        ...sharedLoginState,
        pending: false
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
  const version = readCodexVersion();

  if (!version) {
    return {
      account: null,
      authenticated: false,
      error: "",
      installed: false,
      loginError: "",
      loginPending: false,
      models: [],
      ready: false,
      requiresOpenaiAuth: true,
      runtimeStatus: "missing",
      version: ""
    };
  }

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
      pending: false
    };
  }

  return {
    account,
    authenticated,
    error: "",
    installed: true,
    loginError: sharedLoginState.error,
    loginPending: sharedLoginState.pending,
    models: normalizeModelList(modelResult),
    ready: authenticated,
    requiresOpenaiAuth: accountResult?.requiresOpenaiAuth !== false,
    runtimeStatus: authenticated ? "ready" : "unauthenticated",
    version
  };
}

export async function startCodexLogin() {
  if (!isCodexInstalled()) {
    throw createCodexUnavailableError();
  }

  const connection = await getSharedConnection();
  const result = await connection.call("account/login/start", {
    type: "chatgpt"
  });

  sharedLoginState = {
    error: "",
    loginId: String(result?.loginId || "").trim(),
    pending: true
  };

  return {
    authUrl: String(result?.authUrl || "").trim(),
    loginId: String(result?.loginId || "").trim(),
    type: String(result?.type || "chatgpt").trim()
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
    developerInstructions,
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

  const turnStartResult = await connection.call("turn/start", {
    approvalPolicy: "never",
    input: [
      {
        text: lastMessage.content,
        type: "text"
      }
    ],
    model: String(options.model || "").trim() || null,
    outputSchema: {
      type: "string"
    },
    personality: "none",
    sandboxPolicy: {
      access: {
        readableRoots: [],
        type: "restricted"
      },
      networkAccess: false,
      type: "readOnly"
    },
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
  if (!isCodexInstalled()) {
    throw createCodexUnavailableError();
  }

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
      stream.destroy(error);
    }

    await cleanup();
  }

  function handleClosed() {
    void fail(new Error("Codex completion stream closed unexpectedly."));
  }

  function handleNotification(notification = {}) {
    const method = String(notification?.method || "").trim();
    const params = notification?.params || {};

    if (String(params?.turnId || "").trim() !== turnId) {
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
    }
  }

  connection.on("notification", handleNotification);
  connection.on("closed", handleClosed);
  stream.on("close", () => {
    void cleanup();
  });

  return stream;
}
