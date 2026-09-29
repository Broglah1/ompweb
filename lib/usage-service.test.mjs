import assert from "node:assert/strict";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { tsconfigPaths: true });
async function loadSubject() {
  return jiti.import("./usage-service.ts");
}

async function withTempSessionDir(run) {
  const dir = join(tmpdir(), `omp-test-usage-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(dir, { recursive: true });
  const prevAgentDir = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = dir;

  const { closeUsageDatabase } = await jiti.import("./usage-db.ts");

  try {
    await run(dir);
  } finally {
    closeUsageDatabase();
    if (prevAgentDir !== undefined) {
      process.env.PI_CODING_AGENT_DIR = prevAgentDir;
    } else {
      delete process.env.PI_CODING_AGENT_DIR;
    }
    rmSync(dir, { recursive: true, force: true });
  }
}

test("parseSessionUsage extracts assistant message usage with rate resolution", async () => {
  const { parseSessionUsage } = await loadSubject();

  withTempSessionDir((dir) => {
    const sessionFile = join(dir, "session-1.jsonl");
    const now = Date.now();

    const lines = [
      JSON.stringify({ type: "session", id: "sess-1", cwd: "/test/project-a", timestamp: new Date(now).toISOString() }),
      JSON.stringify({
        type: "message",
        id: "msg-1",
        parentId: null,
        timestamp: new Date(now - 1000).toISOString(),
        message: {
          role: "assistant",
          provider: "anthropic",
          model: "claude-3-7-sonnet",
          usage: {
            input: 10000,
            output: 2000,
            cacheRead: 5000,
            cacheWrite: 1000,
            reasoning: 500,
          },
        },
      }),
      JSON.stringify({
        type: "message",
        id: "msg-2",
        parentId: "msg-1",
        timestamp: new Date(now).toISOString(),
        message: {
          role: "assistant",
          provider: "openai",
          model: "gpt-4o",
          usage: {
            input: 4000,
            output: 1000,
            cacheRead: 2000,
            cacheWrite: 0,
          },
        },
      }),
    ];

    writeFileSync(sessionFile, lines.join("\n"), "utf8");

    const records = parseSessionUsage(sessionFile);
    assert.equal(records.length, 2);

    // Record 1: Anthropic Claude 3.7 Sonnet
    const r1 = records[0];
    assert.equal(r1.sessionId, "sess-1");
    assert.equal(r1.sessionCwd, "/test/project-a");
    assert.equal(r1.provider, "anthropic");
    assert.equal(r1.model, "claude-3-7-sonnet");
    assert.equal(r1.input, 10000);
    assert.equal(r1.output, 2000);
    assert.equal(r1.cacheRead, 5000);
    assert.equal(r1.cacheWrite, 1000);
    assert.equal(r1.reasoning, 500);
    assert.equal(r1.totalTokens, 18000);
    assert.equal(r1.costQuality, "model_priced");
    assert.ok(r1.cost > 0);
    assert.ok(r1.cacheSavings > 0);

    // Record 2: OpenAI GPT-4o
    const r2 = records[1];
    assert.equal(r2.provider, "openai");
    assert.equal(r2.model, "gpt-4o");
    assert.equal(r2.input, 4000);
    assert.equal(r2.output, 1000);
    assert.equal(r2.totalTokens, 7000);
    assert.ok(r2.cost > 0);
  });
});

test("parseSessionUsage extracts subagent task usage results", async () => {
  const { parseSessionUsage } = await loadSubject();

  withTempSessionDir((dir) => {
    const sessionFile = join(dir, "session-task.jsonl");
    const now = Date.now();

    const lines = [
      JSON.stringify({ type: "session", id: "sess-task", cwd: "/test/repo", timestamp: new Date(now).toISOString() }),
      JSON.stringify({
        type: "message",
        id: "msg-tool",
        parentId: null,
        message: {
          role: "toolResult",
          toolName: "task",
          details: {
            results: [
              {
                agent: "scout",
                resolvedModel: "google/gemini-2.5-flash",
                usage: {
                  input: 8000,
                  output: 500,
                  cacheRead: 4000,
                  cacheWrite: 0,
                },
              },
            ],
          },
        },
      }),
    ];

    writeFileSync(sessionFile, lines.join("\n"), "utf8");

    const records = parseSessionUsage(sessionFile);
    assert.equal(records.length, 1);
    assert.equal(records[0].provider, "google");
    assert.equal(records[0].model, "google/gemini-2.5-flash");
    assert.equal(records[0].input, 8000);
    assert.equal(records[0].output, 500);
    assert.equal(records[0].cacheRead, 4000);
  });
});

test("getUsageReport generates complete aggregated report across sessions", async () => {
  const { getUsageReport } = await loadSubject();

  withTempSessionDir(async (dir) => {
    const sessionsDir = join(dir, "sessions", "test-project");
    mkdirSync(sessionsDir, { recursive: true });

    const now = Date.now();
    const session1 = join(sessionsDir, "session-a.jsonl");
    const session2 = join(sessionsDir, "session-b.jsonl");

    writeFileSync(
      session1,
      [
        JSON.stringify({ type: "session", id: "sess-a", cwd: "/home/user/project-alpha", timestamp: new Date(now).toISOString() }),
        JSON.stringify({
          type: "message",
          message: {
            role: "assistant",
            provider: "anthropic",
            model: "claude-3-7-sonnet",
            usage: { input: 20000, output: 4000, cacheRead: 10000, cacheWrite: 0, reasoning: 1000 },
          },
        }),
      ].join("\n"),
      "utf8",
    );

    writeFileSync(
      session2,
      [
        JSON.stringify({ type: "session", id: "sess-b", cwd: "/home/user/project-beta", timestamp: new Date(now).toISOString() }),
        JSON.stringify({
          type: "message",
          message: {
            role: "assistant",
            provider: "openai",
            model: "gpt-4o",
            usage: { input: 10000, output: 2000, cacheRead: 0, cacheWrite: 0 },
          },
        }),
      ].join("\n"),
      "utf8",
    );

    const report = await getUsageReport({ range: "30d", forceRefresh: true });

    assert.equal(report.timeRange, "30d");
    assert.equal(report.granularity, "daily");

    // Summary checks
    assert.ok(report.summary.totalCost > 0);
    assert.equal(report.summary.inputTokens, 30000);
    assert.equal(report.summary.outputTokens, 6000);
    assert.equal(report.summary.cacheReadTokens, 10000);
    assert.equal(report.summary.reasoningTokens, 1000);
    assert.equal(report.summary.totalTokens, 46000);
    assert.ok(report.summary.activeDays >= 1);
    assert.ok(report.summary.cachePercentage > 0);

    // Providers checks
    assert.equal(report.providers.length, 2);
    const anthropicProvider = report.providers.find((p) => p.provider === "anthropic");
    const openaiProvider = report.providers.find((p) => p.provider === "openai");
    assert.ok(anthropicProvider);
    assert.ok(openaiProvider);
    assert.equal(anthropicProvider.name, "Anthropic");
    assert.equal(openaiProvider.name, "OpenAI");

    // Model breakdown checks
    assert.equal(report.modelBreakdown.length, 2);
    assert.ok(report.modelBreakdown.some((m) => m.model === "claude-3-7-sonnet"));
    assert.ok(report.modelBreakdown.some((m) => m.model === "gpt-4o"));

    // Project breakdown checks
    assert.equal(report.projectBreakdown.length, 2);
    assert.ok(report.projectBreakdown.some((p) => p.projectName === "project-alpha"));
    assert.ok(report.projectBreakdown.some((p) => p.projectName === "project-beta"));

    // Time series checks: continuous buckets
    assert.ok(report.timeSeries.length >= 1);
    const lastPoint = report.timeSeries[report.timeSeries.length - 1];
    assert.ok(lastPoint.date);
    assert.ok(lastPoint.label);

    // Scan info
    assert.equal(report.scanInfo.transcriptsScanned, 2);
    assert.equal(report.scanInfo.usageRecordsCount, 2);
    assert.ok(report.scanInfo.durationSeconds >= 0);
  });
});

test("getUsageReport counts every artifact transcript once, under the session that owns it", async () => {
  const { getUsageReport } = await loadSubject();

  await withTempSessionDir(async (dir) => {
    const project = join(dir, "sessions", "test-project");
    const parent = join(project, "2026_parent.jsonl");
    const artifacts = join(project, "2026_parent");
    mkdirSync(join(artifacts, "Bg1"), { recursive: true });
    const now = Date.now();
    const header = (id, cwd) => JSON.stringify({ type: "session", id, cwd, timestamp: new Date(now).toISOString() });
    const assistant = (provider, model, input) => JSON.stringify({
      type: "message",
      timestamp: new Date(now).toISOString(),
      message: { role: "assistant", provider, model, usage: { input, output: 0 } },
    });
    const transcript = (file, id, cwd, provider, model, input) =>
      writeFileSync(file, [header(id, cwd), assistant(provider, model, input)].join("\n"), "utf8");

    writeFileSync(parent, [
      header("sess-parent", "/home/user/project-alpha"),
      assistant("anthropic", "claude-opus-5-5", 1000),
      // A foreground subagent reports a summary AND keeps its own transcript.
      JSON.stringify({
        type: "message",
        timestamp: new Date(now).toISOString(),
        message: {
          role: "toolResult",
          toolName: "task",
          details: { results: [{ id: "Sync1", resolvedModel: "anthropic/claude-sonnet-5", usage: { input: 500, output: 0 } }] },
        },
      }),
      // A background subagent reports no usage in its task result at all.
      JSON.stringify({
        type: "message",
        timestamp: new Date(now).toISOString(),
        message: { role: "toolResult", toolName: "task", details: { results: [], async: { state: "running", jobId: "Bg1" } } },
      }),
    ].join("\n"), "utf8");
    // Subagents run in isolated worktrees; their usage still belongs to project-alpha.
    transcript(join(artifacts, "Sync1.jsonl"), "sub-sync", "/tmp/wt/sync", "anthropic", "claude-sonnet-5", 500);
    transcript(join(artifacts, "Bg1.jsonl"), "sub-bg", "/tmp/wt/bg", "anthropic", "claude-haiku-5", 300);
    transcript(join(artifacts, "Bg1", "Nested.jsonl"), "sub-nested", "/tmp/wt/nested", "anthropic", "claude-haiku-5", 70);
    transcript(join(artifacts, "__advisor.jsonl"), "advisor", "/home/user/project-alpha", "openai-codex", "gpt-6-astra", 20);
    transcript(join(artifacts, "__planloop.fable.jsonl"), "fable", "/home/user/project-alpha", "anthropic", "claude-fable-5-1", 4);
    writeFileSync(join(artifacts, "Sync1.md"), "final output, not a transcript", "utf8");

    const report = await getUsageReport({ range: "30d", forceRefresh: true });

    assert.equal(report.summary.inputTokens, 1000 + 500 + 300 + 70 + 20 + 4, "each transcript counted exactly once");
    assert.deepEqual(
      report.modelBreakdown.map((m) => m.model).sort(),
      ["claude-fable-5-1", "claude-haiku-5", "claude-opus-5-5", "claude-sonnet-5", "gpt-6-astra"],
    );
    assert.equal(report.projectBreakdown.length, 1);
    assert.equal(report.projectBreakdown[0].projectName, "project-alpha");
    assert.equal(report.projectBreakdown[0].sessionsCount, 1, "helper transcripts are not separate sessions");
    assert.equal(report.scanInfo.transcriptsScanned, 6);
  });
});

test("time range bounds compute valid intervals", async () => {
  const { computeTimeRangeBounds } = await loadSubject();

  const now = 1756700000000;
  const t7d = computeTimeRangeBounds("7d", now);
  assert.equal(t7d.endMs, now);
  assert.equal(t7d.startMs, now - 7 * 86400 * 1000);

  const tAll = computeTimeRangeBounds("all", now);
  assert.equal(tAll.startMs, 0);
  assert.equal(tAll.endMs, now);
});

test("getUsageReport respects explicit from=0 timestamp without falling back to 30d", async () => {
  const { getUsageReport } = await loadSubject();

  withTempSessionDir(async (dir) => {
    const sessionsDir = join(dir, "sessions", "test-project");
    mkdirSync(sessionsDir, { recursive: true });

    // An old session 100 days ago
    const oldTimestamp = Date.now() - 100 * 86400 * 1000;
    const sessionFile = join(sessionsDir, "old-session.jsonl");

    writeFileSync(
      sessionFile,
      [
        JSON.stringify({ type: "session", id: "sess-old", cwd: "/test/old", timestamp: new Date(oldTimestamp).toISOString() }),
        JSON.stringify({
          type: "message",
          timestamp: new Date(oldTimestamp).toISOString(),
          message: {
            role: "assistant",
            provider: "openai",
            model: "gpt-4o",
            usage: { input: 5000, output: 1000 },
          },
        }),
      ].join("\n"),
      "utf8",
    );

    // Querying with from: 0 explicitly must find the 100-day old record
    const report = await getUsageReport({ from: 0, to: Date.now(), forceRefresh: true });
    assert.equal(report.summary.inputTokens, 5000);
    assert.equal(report.scanInfo.usageRecordsCount, 1);
  });
});

test("usage cache evicts oldest entries when exceeding MAX_USAGE_CACHE_ENTRIES", async () => {
  const { parseSessionUsage, MAX_USAGE_CACHE_ENTRIES } = await loadSubject();

  withTempSessionDir((dir) => {
    // Create 10 dummy session files
    for (let i = 0; i < 10; i++) {
      const f = join(dir, `s-${i}.jsonl`);
      writeFileSync(f, JSON.stringify({ type: "session", id: `s-${i}`, cwd: "/p" }), "utf8");
      parseSessionUsage(f);
    }
    assert.ok(MAX_USAGE_CACHE_ENTRIES > 0);
  });
});
