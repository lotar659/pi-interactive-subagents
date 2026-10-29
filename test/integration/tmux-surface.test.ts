/**
 * Integration tests for the tmux surface layer.
 *
 * These tests exercise real tmux operations: creating panes,
 * sending commands, reading screen output, and closing panes.
 * No LLM calls — fast and free.
 *
 * Run inside tmux:
 *   tmux new 'npm run test:integration'
 */
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { unlinkSync, writeFileSync } from "node:fs";
import { pollForExit } from "../../pi-extension/subagents/tmux.ts";
import {
  getAvailableBackends,
  createTestEnv,
  cleanupTestEnv,
  createTrackedSurface,
  createTrackedSurfaceSplit,
  focusSurface,
  getFocusedSurface,
  waitForFocusedSurface,
  untrackSurface,
  sendCommand,
  sendLongCommand,
  readScreen,
  readScreenAsync,
  closeSurface,
  shellEscape,
  sleep,
  uniqueId,
  trackTempFile,
  waitForFile,
  waitForScreen,
  type TestEnv,
} from "./harness.ts";

const backends = getAvailableBackends();
const FOCUS_TEST_SHELL_READY_DELAY_MS = Number(process.env.PI_SUBAGENT_SHELL_READY_DELAY_MS ?? "2500");

if (backends.length === 0) {
  console.log("⚠️  tmux is not available — skipping tmux-surface integration tests");
  console.log("   Run inside tmux to enable these tests.");
}

for (const backend of backends) {
  describe(`tmux-surface [${backend}]`, { timeout: 60_000 }, () => {
    let env: TestEnv;

    before(() => {
      env = createTestEnv();
    });

    after(() => {
      cleanupTestEnv(env);
    });

    it("keeps focus on the active surface while creating and targeting subagent surfaces", async () => {
      const anchor = createTrackedSurfaceSplit(env, "focus-anchor", "right");
      await sleep(1000);

      focusSurface(anchor);
      await waitForFocusedSurface(anchor, 10_000);

      const childA = createTrackedSurface(env, "focus-child-a");
      await sleep(FOCUS_TEST_SHELL_READY_DELAY_MS);
      assert.equal(getFocusedSurface(), anchor);

      const childB = createTrackedSurface(env, "focus-child-b");
      await sleep(FOCUS_TEST_SHELL_READY_DELAY_MS);
      assert.equal(getFocusedSurface(), anchor);

      const markerA = uniqueId();
      const markerB = uniqueId();
      sendCommand(childA, `echo "FOCUS_A_${markerA}"`);
      sendCommand(childB, `echo "FOCUS_B_${markerB}"`);

      await Promise.all([
        waitForScreen(childA, new RegExp(`FOCUS_A_${markerA}`), 20_000, 50),
        waitForScreen(childB, new RegExp(`FOCUS_B_${markerB}`), 20_000, 50),
      ]);
      assert.equal(getFocusedSurface(), anchor);
    });

    it("creates a surface, sends a command, reads output, and closes it", async () => {
      const surface = createTrackedSurface(env, "echo-test");
      await sleep(1000);

      const marker = uniqueId();
      sendCommand(surface, `echo "MARKER_${marker}"`);
      await sleep(1500);

      const screen = readScreen(surface, 50);
      assert.ok(
        screen.includes(`MARKER_${marker}`),
        `Expected screen to contain MARKER_${marker}. Got:\n${screen}`,
      );

      closeSurface(surface);
      untrackSurface(env, surface);
    });

    it("preserves shell special characters in echo output", async () => {
      const surface = createTrackedSurface(env, "escape-test");
      await sleep(1000);

      const marker = uniqueId();
      // Single-quoted string — $ and " are literal inside single quotes
      sendCommand(surface, `echo 'SPEC_${marker}_$HOME_"quotes"_done'`);
      await sleep(1500);

      const screen = readScreen(surface, 50);
      assert.ok(
        screen.includes(`SPEC_${marker}`),
        `Expected special-char output. Got:\n${screen}`,
      );
      // $ should be literal inside single quotes
      assert.ok(
        screen.includes("$HOME"),
        `Expected literal $HOME in output. Got:\n${screen}`,
      );
    });

    it("sends a long command via script file without truncation", async () => {
      const surface = createTrackedSurface(env, "long-cmd-test");
      await sleep(1000);

      const marker = uniqueId();
      const longValue = "X".repeat(500);
      const command = `echo "LONG_${marker}_${longValue}_END"`;

      sendLongCommand(surface, command);
      await sleep(2000);

      const screen = readScreen(surface, 50);
      assert.ok(
        screen.includes(`LONG_${marker}`),
        `Expected long command output. Got:\n${screen.slice(0, 300)}...`,
      );
      assert.ok(
        screen.includes("_END"),
        `Expected full output (not truncated). Got:\n${screen.slice(-300)}`,
      );
    });

    it("reads screen asynchronously", async () => {
      const surface = createTrackedSurface(env, "async-read-test");
      await sleep(1000);

      const marker = uniqueId();
      sendCommand(surface, `echo "ASYNC_${marker}"`);
      await sleep(1500);

      const screen = await readScreenAsync(surface, 50);
      assert.ok(
        screen.includes(`ASYNC_${marker}`),
        `Async read should find marker. Got:\n${screen}`,
      );
    });

    it("manages multiple surfaces concurrently", async () => {
      const s1 = createTrackedSurface(env, "multi-1");
      const s2 = createTrackedSurface(env, "multi-2");
      await sleep(1500);

      const m1 = uniqueId();
      const m2 = uniqueId();
      sendCommand(s1, `echo "S1_${m1}"`);
      sendCommand(s2, `echo "S2_${m2}"`);
      await sleep(1500);

      const screen1 = readScreen(s1, 50);
      const screen2 = readScreen(s2, 50);

      assert.ok(screen1.includes(`S1_${m1}`), `Surface 1 missing marker. Got:\n${screen1}`);
      assert.ok(screen2.includes(`S2_${m2}`), `Surface 2 missing marker. Got:\n${screen2}`);
    });

    it("writes output to a file and verifies via surface", async () => {
      const surface = createTrackedSurface(env, "file-test");
      await sleep(1000);

      const marker = uniqueId();
      const filePath = `/tmp/pi-tmux-test-${marker}.txt`;

      sendCommand(surface, `echo "FILE_${marker}" > ${filePath} && echo "WRITTEN_${marker}"`);

      await waitForScreen(surface, new RegExp(`WRITTEN_${marker}`), 10_000, 50);
      const content = await waitForFile(filePath, 10_000, new RegExp(`FILE_${marker}`));
      assert.ok(content.includes(`FILE_${marker}`), `File content wrong. Got: ${content}`);

      // Clean up
      try {
        unlinkSync(filePath);
      } catch {}
    });

    // ── Completion signal ──
    //
    // Regression: completion used to rely only on the on-screen sentinel
    // `__SUBAGENT_DONE_<code>__`. tmux wraps rows to the pane width, so in a
    // pane narrower than the sentinel (19 columns) the marker was split across
    // two captured rows and never matched — pollForExit() then looped forever,
    // the pane stayed open and the orchestrator never got the result.

    it("detects completion through the exit sidecar in a pane too narrow for the sentinel", async () => {
      const surface = createTrackedSurface(env, "narrow-sidecar");
      await sleep(1000);

      // 12 columns: `__SUBAGENT_DONE_0__` cannot fit on one row.
      execFileSync("tmux", ["resize-pane", "-t", surface, "-x", "12"], { encoding: "utf8" });
      await sleep(300);

      const marker = uniqueId();
      const exitFile = `/tmp/pi-exit-sidecar-${marker}.exit`;
      // Mirror the real launch script: the sentinel lives in a script FILE, so
      // it only reaches the screen as output (never as echoed input).
      const scriptPath = `/tmp/pi-exit-sidecar-${marker}.sh`;
      writeFileSync(
        scriptPath,
        `printf '{"exitCode":%s}' 0 > ${shellEscape(`${exitFile}.tmp`)} && ` +
          `mv -f ${shellEscape(`${exitFile}.tmp`)} ${shellEscape(exitFile)}\n` +
          `echo '__SUBAGENT_DONE_'$?'__'\n`,
        { mode: 0o755 },
      );
      trackTempFile(env, scriptPath);
      sendCommand(surface, `bash ${shellEscape(scriptPath)}`);

      const result = await pollForExit(surface, new AbortController().signal, {
        interval: 200,
        exitFile,
      });

      assert.deepEqual(result, { reason: "done", exitCode: 0 });
    });

    it("joins wrapped rows so the on-screen sentinel still works at 12 columns", async () => {
      const surface = createTrackedSurface(env, "narrow-sentinel");
      await sleep(1000);

      execFileSync("tmux", ["resize-pane", "-t", surface, "-x", "12"], { encoding: "utf8" });
      await sleep(300);

      // No sidecar: this exercises the screen fallback alone.
      const marker = uniqueId();
      const scriptPath = `/tmp/pi-narrow-sentinel-${marker}.sh`;
      writeFileSync(scriptPath, `echo '__SUBAGENT_DONE_7__'\n`, { mode: 0o755 });
      trackTempFile(env, scriptPath);
      sendCommand(surface, `bash ${shellEscape(scriptPath)}`);

      const result = await pollForExit(surface, new AbortController().signal, {
        interval: 200,
      });

      // `-J` on capture-pane re-joins the wrapped marker; without it this
      // poll never resolves.
      assert.deepEqual(result, { reason: "sentinel", exitCode: 7 });
    });

    it("carries the child exit code from the sidecar in a narrow pane", async () => {
      const surface = createTrackedSurface(env, "narrow-sidecar-code");
      await sleep(1000);

      execFileSync("tmux", ["resize-pane", "-t", surface, "-x", "12"], { encoding: "utf8" });
      await sleep(300);

      const marker = uniqueId();
      const exitFile = `/tmp/pi-exit-sidecar-${marker}.exit`;
      sendCommand(
        surface,
        `printf '{"exitCode":%s}' 137 > ${exitFile}.tmp && mv -f ${exitFile}.tmp ${exitFile}`,
      );

      const result = await pollForExit(surface, new AbortController().signal, {
        interval: 200,
        exitFile,
      });

      assert.deepEqual(result, { reason: "done", exitCode: 137 });
    });

    it("stops polling with an error once the pane is gone and no sidecar was written", async () => {
      const surface = createTrackedSurface(env, "vanished-pane");
      await sleep(1000);

      const marker = uniqueId();
      const exitFile = `/tmp/pi-exit-sidecar-${marker}.exit`;
      const sessionFile = `/tmp/pi-exit-sidecar-${marker}.jsonl`;

      const polling = pollForExit(surface, new AbortController().signal, {
        interval: 5,
        exitFile,
        sessionFile,
      });

      // Destroy the pane while the child is still "running".
      await sleep(50);
      closeSurface(surface);
      untrackSurface(env, surface);

      const result = await polling;
      assert.equal(result.reason, "error");
      assert.match(result.errorMessage ?? "", /unreadable/);

      // A sidecar written after the pane died still wins on the next check.
      writeFileSync(`${sessionFile}.exit`, JSON.stringify({ exitCode: 0 }));
      try {
        unlinkSync(`${sessionFile}.exit`);
      } catch {}
    });
  });
}
