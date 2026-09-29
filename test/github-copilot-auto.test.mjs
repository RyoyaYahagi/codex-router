import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  githubCopilotAutoResponse,
  resetGitHubCopilotAutoForTests,
} from "../src/github-copilot-auto.mjs";
import { LISTED_MODELS, MODEL_BY_SLUG } from "../src/model-registry.mjs";

test("Copilot Auto is a listed virtual model on the existing provider", () => {
  const model = MODEL_BY_SLUG.get("github-copilot/auto");
  assert.ok(model);
  assert.ok(LISTED_MODELS.includes(model));
  assert.equal(model.provider, "github-copilot");
  assert.equal(model.upstreamModel, "auto");
  assert.equal(model.gatewayModel, "github-copilot-auto");
  assert.equal(model.displayName, "GitHub Copilot / Auto");
  assert.deepEqual(model.supportedEndpoints, ["/responses"]);
  assert.equal(model.authProfile, undefined);
});

function fakeClientFactory(onCreate) {
  const listeners = new Map();
  const rpcCalls = [];
  const session = {
    rpc: { tools: { handlePendingToolCall: async (value) => rpcCalls.push(value) } },
    on(type, callback) {
      const list = listeners.get(type) || [];
      list.push(callback);
      listeners.set(type, list);
      return () => listeners.set(type, list.filter((item) => item !== callback));
    },
    async send({ prompt }) {
      assert.equal(prompt, "user: Tell me something.");
      for (const callback of listeners.get("assistant.message") || []) {
        callback({ data: { content: "OK", toolRequests: [] } });
      }
      for (const callback of listeners.get("session.idle") || []) callback({ data: {} });
    },
    async disconnect() {},
  };
  const client = {
    async start() {},
    async stop() {},
    async createSession(config) {
      onCreate(config);
      return session;
    },
  };
  return { client, session, listeners, rpcCalls };
}

test("Copilot Auto creates an isolated CLI session with the stored token and returns a Responses result", async () => {
  resetGitHubCopilotAutoForTests();
  const autoHome = mkdtempSync(path.join(os.tmpdir(), "copilot-auto-test-"));
  let clientOptions;
  let sessionConfig;
  const fake = fakeClientFactory((config) => { sessionConfig = config; });
  try {
    const response = await githubCopilotAutoResponse({
      githubToken: "github_pat_SECRET_FIXTURE",
      payload: { input: [{ type: "message", role: "user", content: "Tell me something." }], stream: false },
      autoHome,
      ensureSession: async (token) => ({ token }),
      clientFactory: (options) => { clientOptions = options; return fake.client; },
    });
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.model, "auto");
    assert.equal(body.output[0].content[0].text, "OK");
    assert.equal(sessionConfig.model, "auto");
    assert.equal(sessionConfig.gitHubToken, "github_pat_SECRET_FIXTURE");
    assert.equal(sessionConfig.enableSessionStore, false);
    assert.deepEqual(clientOptions, {
      mode: "empty",
      useLoggedInUser: false,
      baseDirectory: autoHome,
      workingDirectory: autoHome,
      logLevel: "error",
      telemetry: { captureContent: false },
    });
    assert.doesNotMatch(JSON.stringify(body), /SECRET_FIXTURE/);
  } finally {
    resetGitHubCopilotAutoForTests();
    rmSync(autoHome, { recursive: true, force: true });
  }
});

test("Copilot Auto maps Responses function calls and returns tool results to the pending SDK session", async () => {
  resetGitHubCopilotAutoForTests();
  const autoHome = mkdtempSync(path.join(os.tmpdir(), "copilot-auto-tools-"));
  const listeners = new Map();
  const rpcCalls = [];
  let createdConfig;
  const session = {
    rpc: { tools: { handlePendingToolCall: async (value) => {
      rpcCalls.push(value);
      for (const callback of listeners.get("assistant.message") || []) callback({ data: { content: "Found it.", toolRequests: [] } });
      for (const callback of listeners.get("session.idle") || []) callback({ data: {} });
    } } },
    on(type, callback) {
      const list = listeners.get(type) || [];
      list.push(callback);
      listeners.set(type, list);
      return () => listeners.set(type, list.filter((item) => item !== callback));
    },
    async send({ prompt }) {
      assert.equal(prompt, "user: Use the lookup tool.");
      const message = { data: { content: "", toolRequests: [{ toolCallId: "call-1", name: "lookup", arguments: { q: "x" } }] } };
      for (const callback of listeners.get("assistant.message") || []) callback(message);
      for (const callback of listeners.get("external_tool.requested") || []) callback({ data: { toolCallId: "call-1", requestId: "req-1" } });
    },
    async disconnect() {},
  };
  const client = { async start() {}, async stop() {}, async createSession(config) { createdConfig = config; return session; } };
  try {
    const first = await githubCopilotAutoResponse({
      githubToken: "github_pat_TOOL_FIXTURE",
      payload: {
        input: [{ type: "message", role: "user", content: "Use the lookup tool." }],
        tools: [{ type: "function", name: "lookup", description: "Look up a value", parameters: { type: "object", properties: { q: { type: "string" } } } }],
      },
      autoHome,
      ensureSession: async (token) => ({ token }),
      clientFactory: () => client,
    });
    assert.equal(first.status, 200);
    const result = await first.json();
    assert.equal(result.output[0].type, "function_call");
    assert.equal(result.output[0].call_id, "call-1");
    assert.deepEqual(createdConfig.tools, [{
      name: "lookup",
      description: "Look up a value",
      parameters: { type: "object", properties: { q: { type: "string" } } },
      defer: "never",
    }]);
    const second = await githubCopilotAutoResponse({
      githubToken: "github_pat_TOOL_FIXTURE",
      payload: { previous_response_id: result.id, input: [{ type: "function_call_output", call_id: "call-1", output: "found" }] },
      autoHome,
      ensureSession: async (token) => ({ token }),
      clientFactory: () => client,
    });
    assert.equal(second.status, 200);
    assert.equal((await second.json()).output[0].content[0].text, "Found it.");
    assert.deepEqual(rpcCalls, [{ requestId: "req-1", result: "found" }]);
  } finally {
    resetGitHubCopilotAutoForTests();
    rmSync(autoHome, { recursive: true, force: true });
  }
});

test("Copilot Auto refuses tool_choice values it cannot preserve", async () => {
  resetGitHubCopilotAutoForTests();
  const autoHome = mkdtempSync(path.join(os.tmpdir(), "copilot-auto-tool-choice-"));
  let created = false;
  const client = {
    async start() {},
    async stop() {},
    async createSession() { created = true; throw new Error("must not create session"); },
  };
  try {
    const result = await githubCopilotAutoResponse({
      githubToken: "github_pat_TOOL_CHOICE_FIXTURE",
      payload: { input: "Use a tool.", tool_choice: "required" },
      autoHome,
      ensureSession: async (token) => ({ token }),
      clientFactory: () => client,
    });
    assert.equal(result.status, 400);
    assert.equal(created, false);
    assert.match((await result.json()).error.message, /tool_choice auto or none/);
  } finally {
    resetGitHubCopilotAutoForTests();
    rmSync(autoHome, { recursive: true, force: true });
  }
});

test("Copilot Auto expires and disconnects old sessions instead of selecting a fallback model", async () => {
  resetGitHubCopilotAutoForTests();
  const autoHome = mkdtempSync(path.join(os.tmpdir(), "copilot-auto-expire-"));
  let disconnected = 0;
  const fake = fakeClientFactory(() => {});
  fake.session.disconnect = async () => { disconnected += 1; };
  try {
    const first = await githubCopilotAutoResponse({
      githubToken: "github_pat_EXPIRY_FIXTURE",
      payload: { input: [{ type: "message", role: "user", content: "Tell me something." }] },
      autoHome,
      sessionTtlMs: 1,
      ensureSession: async (token) => ({ token }),
      clientFactory: () => fake.client,
    });
    const responseId = (await first.json()).id;
    await new Promise((resolve) => setTimeout(resolve, 5));
    const next = await githubCopilotAutoResponse({
      githubToken: "github_pat_EXPIRY_FIXTURE",
      payload: { previous_response_id: responseId, input: "Continue." },
      autoHome,
      sessionTtlMs: 1,
      ensureSession: async (token) => ({ token }),
      clientFactory: () => fake.client,
    });
    assert.equal(next.status, 409);
    assert.match((await next.json()).error.message, /expired or was restarted/);
    assert.equal(disconnected, 1);
  } finally {
    resetGitHubCopilotAutoForTests();
    rmSync(autoHome, { recursive: true, force: true });
  }
});

test("Copilot Auto can force-refresh the existing credential session after an SDK 401", async () => {
  resetGitHubCopilotAutoForTests();
  const autoHome = mkdtempSync(path.join(os.tmpdir(), "copilot-auto-refresh-"));
  const calls = [];
  const fake = fakeClientFactory(() => {});
  const listeners = new Map();
  const session = {
    on(type, callback) {
      const group = listeners.get(type) || [];
      group.push(callback);
      listeners.set(type, group);
      return () => listeners.set(type, group.filter((entry) => entry !== callback));
    },
    async send() {
      for (const callback of listeners.get("session.error") || []) {
        callback({ data: { message: "Copilot request failed with HTTP 401 Unauthorized" } });
      }
    },
    async disconnect() {},
  };
  fake.client.createSession = async () => session;
  try {
    const result = await githubCopilotAutoResponse({
      githubToken: "github_pat_REFRESH_FIXTURE",
      payload: { input: "Tell me something." },
      autoHome,
      forceSession: true,
      ensureSession: async (token, options) => { calls.push(options); return { token }; },
      clientFactory: () => fake.client,
    });
    assert.equal(result.status, 401);
    assert.deepEqual(calls, [{ force: true }]);
  } finally {
    resetGitHubCopilotAutoForTests();
    rmSync(autoHome, { recursive: true, force: true });
  }
});

test("Copilot Auto debug logging reports only the selected model", async () => {
  resetGitHubCopilotAutoForTests();
  const autoHome = mkdtempSync(path.join(os.tmpdir(), "copilot-auto-log-"));
  const logs = [];
  const previousDebug = process.env.CODEX_ROUTER_DEBUG;
  process.env.CODEX_ROUTER_DEBUG = "1";
  const previousError = console.error;
  console.error = (...values) => logs.push(values.join(" "));
  const listeners = new Map();
  const session = {
    on(type, callback) {
      const group = listeners.get(type) || [];
      group.push(callback);
      listeners.set(type, group);
      return () => listeners.set(type, group.filter((entry) => entry !== callback));
    },
    async send() {
      for (const callback of listeners.get("session.auto_mode_resolved") || []) {
        callback({ data: { chosenModel: "gpt-5.6-sol" } });
      }
      for (const callback of listeners.get("assistant.message") || []) callback({ data: { content: "private prompt was not logged", toolRequests: [] } });
      for (const callback of listeners.get("session.idle") || []) callback({ data: {} });
    },
    async disconnect() {},
  };
  const client = { async start() {}, async stop() {}, async createSession() { return session; } };
  try {
    const result = await githubCopilotAutoResponse({
      githubToken: "github_pat_LOG_FIXTURE",
      payload: { input: "private prompt was not logged" },
      autoHome,
      ensureSession: async (token) => ({ token }),
      clientFactory: () => client,
    });
    assert.equal(result.status, 200);
    assert.deepEqual(logs, ["[github-copilot-auto] selected model=gpt-5.6-sol"]);
    assert.doesNotMatch(logs.join(" "), /LOG_FIXTURE|private prompt/);
  } finally {
    console.error = previousError;
    if (previousDebug === undefined) delete process.env.CODEX_ROUTER_DEBUG;
    else process.env.CODEX_ROUTER_DEBUG = previousDebug;
    resetGitHubCopilotAutoForTests();
    rmSync(autoHome, { recursive: true, force: true });
  }
});
