import { createHash, randomUUID } from "node:crypto";
import { chmodSync, mkdirSync } from "node:fs";
import path from "node:path";

import { CopilotClient } from "@github/copilot-sdk";
import { STATE_DIR } from "./paths.mjs";
import { ensureFreshGitHubCopilotSession } from "./github-copilot-session.mjs";

// Auto is handled by GitHub's public Copilot SDK, which starts its bundled
// Copilot CLI runtime and speaks its JSON-RPC session protocol. The router does
// not guess an Auto-specific REST endpoint or headers; the SDK/runtime wire
// contract can evolve independently of the direct Responses provider path.
const AUTO_HOME = path.join(STATE_DIR, "github-copilot-auto");
const SESSION_TTL_MS = 30 * 60_000;
const DEFAULT_TIMEOUT_MS = 5 * 60_000;
const clients = new Map();
const responseSessions = new Map();
const pendingToolCalls = new Map();

function tokenKey(token) {
  return createHash("sha256").update(token).digest("hex");
}

function safeDirectory(directory) {
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  chmodSync(directory, 0o700);
}

function openAiTools(tools, toolChoice) {
  if (toolChoice === "none") return [];
  if (toolChoice !== undefined && toolChoice !== "auto") {
    const error = new Error("GitHub Copilot Auto currently supports tool_choice auto or none.");
    error.status = 400;
    throw error;
  }
  if (!Array.isArray(tools)) return [];
  const result = [];
  for (const item of tools) {
    const declaration = item?.function || item;
    if (item?.type !== "function" || typeof declaration?.name !== "string") {
      const error = new Error("GitHub Copilot Auto currently supports function tools only.");
      error.status = 400;
      throw error;
    }
    result.push({
      name: declaration.name,
      description: declaration.description || "",
      parameters: declaration.parameters || { type: "object", properties: {} },
      defer: "never",
    });
  }
  return result;
}

function renderContent(content, attachments = []) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  const text = [];
  for (const part of content) {
    if (part?.type === "input_text" || part?.type === "text") {
      if (part.text) text.push(part.text);
    } else if (part?.type === "refusal") {
      if (part.refusal) text.push(part.refusal);
    } else if (part?.type === "input_image") {
      const match = typeof part.image_url === "string"
        ? part.image_url.match(/^data:(image\/[a-zA-Z0-9.+-]+);base64,([A-Za-z0-9+/=]+)$/)
        : undefined;
      if (!match) {
        const error = new Error("GitHub Copilot Auto accepts images only as inline base64 data URLs.");
        error.status = 400;
        throw error;
      }
      attachments.push({ type: "blob", mimeType: match[1], data: match[2] });
    } else {
      const error = new Error(`GitHub Copilot Auto does not support Responses content type ${String(part?.type || "unknown")}.`);
      error.status = 400;
      throw error;
    }
  }
  return text.join("\n");
}

function promptFromInput(input) {
  if (typeof input === "string") return { prompt: input, attachments: [] };
  if (!Array.isArray(input)) {
    const error = new Error("GitHub Copilot Auto requires a Responses API input string or item list.");
    error.status = 400;
    throw error;
  }
  const lines = [];
  const attachments = [];
  for (const item of input) {
    if (item?.type === "function_call_output") continue;
    if (item?.type === "message") {
      const text = renderContent(item.content, attachments);
      if (text) lines.push(`${item.role || "user"}: ${text}`);
      continue;
    }
    if (item?.type === "function_call") continue;
    const error = new Error(`GitHub Copilot Auto does not support Responses input item type ${String(item?.type || "unknown")}.`);
    error.status = 400;
    throw error;
  }
  return { prompt: lines.join("\n\n"), attachments };
}

function responseObject(id, output, requestedModel) {
  return {
    id,
    object: "response",
    created_at: Math.floor(Date.now() / 1000),
    status: "completed",
    error: null,
    incomplete_details: null,
    instructions: null,
    max_output_tokens: null,
    model: requestedModel,
    output,
    parallel_tool_calls: true,
    previous_response_id: null,
    reasoning: { effort: null, summary: null },
    store: false,
    temperature: null,
    text: { format: { type: "text" }, verbosity: "medium" },
    tool_choice: "auto",
    tools: [],
    top_p: null,
    truncation: "disabled",
    usage: null,
  };
}

function outputFromEvent(event) {
  const output = [];
  const content = String(event?.data?.content || "");
  if (content) {
    output.push({
      id: `msg_${randomUUID()}`,
      type: "message",
      status: "completed",
      role: "assistant",
      content: [{ type: "output_text", text: content, annotations: [] }],
    });
  }
  for (const call of event?.data?.toolRequests || []) {
    output.push({
      id: call.toolCallId,
      type: "function_call",
      status: "completed",
      call_id: call.toolCallId,
      name: call.name,
      arguments: typeof call.arguments === "string" ? call.arguments : JSON.stringify(call.arguments ?? {}),
    });
  }
  return output;
}

function errorResponse(status, message) {
  return new Response(JSON.stringify({
    error: {
      type: status === 401 || status === 403 ? "authentication_error" : "invalid_request_error",
      code: status === 400 ? "unsupported_request" : undefined,
      message,
    },
  }), { status, headers: { "content-type": "application/json; charset=utf-8" } });
}

function copilotFailureStatus(error) {
  const numeric = Number(error?.status ?? error?.statusCode ?? error?.data?.status ?? error?.data?.statusCode);
  if ([401, 403, 429].includes(numeric)) return numeric;
  const message = String(error?.message ?? error?.data?.message ?? "");
  const match = /\b(?:HTTP\s*)?(401|403|429)\b/i.exec(message);
  return match ? Number(match[1]) : undefined;
}

function createEventWaiter(session, { signal, timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
  let settle;
  let lastMessage;
  const promise = new Promise((resolve, reject) => {
    let timer;
    const cleanup = () => {
      clearTimeout(timer);
      unsubscribeMessage();
      unsubscribeIdle();
      unsubscribeError();
      signal?.removeEventListener("abort", onAbort);
    };
    const finish = (fn, value) => {
      cleanup();
      fn(value);
    };
    const unsubscribeMessage = session.on("assistant.message", (event) => {
      if (event.agentId) return;
      lastMessage = event;
      if (event.data?.toolRequests?.length) finish(resolve, event);
    });
    const unsubscribeIdle = session.on("session.idle", (event) => {
      if (event.agentId) return;
      if (lastMessage) finish(resolve, lastMessage);
      else finish(reject, Object.assign(new Error("GitHub Copilot Auto returned no assistant message."), { status: 502 }));
    });
    const unsubscribeError = session.on("session.error", (event) => {
      const status = copilotFailureStatus(event);
      finish(reject, Object.assign(new Error("GitHub Copilot Auto session failed."), { status: status || 502 }));
    });
    const onAbort = () => finish(reject, new Error("GitHub Copilot Auto request was cancelled."));
    signal?.addEventListener("abort", onAbort, { once: true });
    timer = setTimeout(() => finish(reject, Object.assign(new Error("GitHub Copilot Auto session timed out."), { status: 504 })), timeoutMs);
    settle = finish;
  });
  return { promise, settle: (...args) => settle?.(...args) };
}

async function createSession(token, payload, client, sessionTtlMs) {
  const session = await client.createSession({
    model: "auto",
    gitHubToken: token,
    streaming: true,
    enableSessionStore: false,
    tools: openAiTools(payload.tools, payload.tool_choice),
    systemMessage: payload.instructions
      ? { mode: "append", content: payload.instructions }
      : undefined,
  });
  const record = {
    session,
    tokenKey: tokenKey(token),
    touchedAt: Date.now(),
    sessionTtlMs,
    actualModel: undefined,
    pending: new Map(),
  };
  session.on("session.auto_mode_resolved", (event) => {
    const model = event.data?.chosenModel;
    if (typeof model === "string" && /^[a-zA-Z0-9._/-]{1,100}$/.test(model)) {
      record.actualModel = model;
      if (process.env.CODEX_ROUTER_DEBUG === "1") {
        console.error(`[github-copilot-auto] selected model=${model}`);
      }
    }
  });
  session.on("external_tool.requested", (event) => {
    if (typeof event.data?.toolCallId === "string" && typeof event.data?.requestId === "string") {
      record.pending.set(event.data.toolCallId, event.data.requestId);
      pendingToolCalls.set(event.data.toolCallId, record);
    }
  });
  return record;
}

function expireSessions(now = Date.now()) {
  const expired = new Set([...responseSessions.values()].filter((record) => now - record.touchedAt > record.sessionTtlMs));
  for (const [id, record] of responseSessions) if (expired.has(record)) responseSessions.delete(id);
  for (const [callId, record] of pendingToolCalls) if (expired.has(record)) pendingToolCalls.delete(callId);
  for (const record of expired) {
    void record.session.disconnect().catch(() => undefined);
  }
}

export async function githubCopilotAutoResponse({
  githubToken,
  payload,
  signal,
  clientFactory = (options) => new CopilotClient(options),
  ensureSession = ensureFreshGitHubCopilotSession,
  autoHome = AUTO_HOME,
  sessionTtlMs = SESSION_TTL_MS,
  forceSession = false,
} = {}) {
  let activeRecord;
  try {
    const validated = await ensureSession(githubToken, forceSession ? { force: true } : undefined);
    const token = validated.token;
    expireSessions();
    const clientKey = tokenKey(token);
    let clientEntry = clients.get(clientKey);
    if (!clientEntry) {
      safeDirectory(autoHome);
      const client = clientFactory({
        mode: "empty",
        useLoggedInUser: false,
        baseDirectory: autoHome,
        workingDirectory: autoHome,
        logLevel: "error",
        telemetry: { captureContent: false },
      });
      clientEntry = { client, starting: Promise.resolve().then(() => client.start()) };
      clientEntry.starting.catch(() => {
        if (clients.get(clientKey) === clientEntry) clients.delete(clientKey);
      });
      clients.set(clientKey, clientEntry);
    }
    await clientEntry.starting;

    let record;
    const priorId = payload.previous_response_id;
    if (typeof priorId === "string") record = responseSessions.get(priorId);
    if (typeof priorId === "string" && !record) {
      return errorResponse(409, "The GitHub Copilot Auto session expired or was restarted. Start a new conversation.");
    }
    const toolOutputs = Array.isArray(payload.input)
      ? payload.input.filter((item) => item?.type === "function_call_output")
      : [];
    if (!record && toolOutputs.length) record = pendingToolCalls.get(toolOutputs[0]?.call_id);
    if (record && record.tokenKey !== clientKey) {
      return errorResponse(409, "The GitHub Copilot Auto session belongs to a different GitHub credential.");
    }
    if (!record) record = await createSession(token, payload, clientEntry.client, sessionTtlMs);
    activeRecord = record;
    record.touchedAt = Date.now();

    const waiter = createEventWaiter(record.session, { signal });
    if (toolOutputs.length) {
      for (const item of toolOutputs) {
        const callId = item.call_id;
        const requestId = record.pending.get(callId);
        if (!requestId) return errorResponse(409, "The GitHub Copilot Auto tool call is no longer pending. Start a new conversation.");
        await record.session.rpc.tools.handlePendingToolCall({ requestId, result: renderContent(item.output) });
        record.pending.delete(callId);
        pendingToolCalls.delete(callId);
      }
    } else await record.session.send(promptFromInput(payload.input));
    const message = await waiter.promise;
    waiter.settle(() => {}, undefined);
    const id = `resp_${randomUUID()}`;
    responseSessions.set(id, record);
    record.touchedAt = Date.now();
    const body = responseObject(id, outputFromEvent(message), "auto");
    const responseBody = payload.stream === true
      ? `event: response.created\ndata: ${JSON.stringify({ type: "response.created", response: { ...body, status: "in_progress", output: [] } })}\n\nevent: response.completed\ndata: ${JSON.stringify({ type: "response.completed", response: body })}\n\ndata: [DONE]\n\n`
      : JSON.stringify(body);
    return new Response(responseBody, {
      status: 200,
      headers: { "content-type": payload.stream === true ? "text/event-stream; charset=utf-8" : "application/json; charset=utf-8" },
    });
  } catch (error) {
    const status = copilotFailureStatus(error) || (Number.isInteger(error?.status) ? error.status : 502);
    if (status === 401 && activeRecord) {
      for (const [id, record] of responseSessions) {
        if (record === activeRecord) responseSessions.delete(id);
      }
      for (const [callId, record] of pendingToolCalls) {
        if (record === activeRecord) pendingToolCalls.delete(callId);
      }
      void activeRecord.session.disconnect().catch(() => undefined);
    }
    const message = status === 400 || status === 409 || status === 504
      ? error.message
      : "GitHub Copilot Auto session could not complete the request.";
    return errorResponse(status, message);
  }
}

export function resetGitHubCopilotAutoForTests() {
  for (const entry of clients.values()) void entry.client.stop().catch(() => undefined);
  clients.clear();
  responseSessions.clear();
  pendingToolCalls.clear();
}
