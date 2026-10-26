import assert from "node:assert/strict";
import { test } from "node:test";
import { formatLatency, formatSpeed, SpeedTracker } from "../src/tracker.ts";

test("records time to first token and generation speed", () => {
	const tracker = new SpeedTracker();
	tracker.startTurn(1_000);
	tracker.noteFirstToken(1_400);
	tracker.noteFirstToken(1_500); // only the first token counts

	const sample = tracker.finish(1_000, 11_400);
	assert.ok(sample);
	assert.equal(sample.inputLatencyMs, 400);
	assert.equal(sample.generationMs, 10_000);
	assert.equal(sample.outputTokens, 1_000);
	assert.equal(sample.speed, 100);
});

test("averages turns by output tokens and generation time", () => {
	const tracker = new SpeedTracker();

	tracker.startTurn(0);
	tracker.noteFirstToken(100);
	tracker.finish(100, 1_100); // 100 tok/s

	tracker.startTurn(2_000);
	tracker.noteFirstToken(2_500);
	tracker.finish(200, 6_500); // 50 tok/s

	const stats = tracker.getStats();
	assert.equal(stats.turns, 2);
	assert.equal(stats.averageInputLatencyMs, 300);
	assert.equal(stats.totalOutputTokens, 300);
	assert.equal(stats.totalGenerationMs, 5_000);
	assert.equal(stats.averageSpeed, 60);
	assert.equal(stats.last?.speed, 50);
	assert.deepEqual(
		stats.recent.map((sample) => sample.outputTokens),
		[100, 200],
	);
});

test("ignores turns without output or without a first token", () => {
	const tracker = new SpeedTracker();

	tracker.startTurn(0);
	tracker.finish(100, 1_000);
	assert.equal(tracker.finish(100, 2_000), undefined);

	tracker.startTurn(3_000);
	tracker.noteFirstToken(3_100);
	assert.equal(tracker.finish(0, 4_000), undefined);

	assert.equal(tracker.getStats().turns, 0);
});

test("a new turn discards an unfinished previous turn", () => {
	const tracker = new SpeedTracker();
	tracker.startTurn(0);
	tracker.noteFirstToken(100);
	tracker.startTurn(2_000);
	tracker.noteFirstToken(2_200);
	tracker.finish(200, 4_200);

	const stats = tracker.getStats();
	assert.equal(stats.turns, 1);
	assert.equal(stats.last?.inputLatencyMs, 200);
});

test("reset clears all metrics", () => {
	const tracker = new SpeedTracker();
	tracker.startTurn(0);
	tracker.noteFirstToken(100);
	tracker.finish(100, 1_100);
	tracker.reset();

	const stats = tracker.getStats();
	assert.equal(stats.turns, 0);
	assert.equal(stats.last, undefined);
	assert.equal(stats.averageSpeed, undefined);
	assert.equal(stats.averageInputLatencyMs, undefined);
	assert.deepEqual(stats.recent, []);
});

test("formats speed and latency compactly", () => {
	assert.equal(formatSpeed(42.34), "42.3");
	assert.equal(formatSpeed(8.421), "8.42");
	assert.equal(formatSpeed(123.6), "124");

	assert.equal(formatLatency(842), "842ms");
	assert.equal(formatLatency(1_234), "1.23s");
	assert.equal(formatLatency(62_000), "1m02s");
});
