/**
 * Per-turn timing used by the speed footer.
 *
 * A turn's output speed is measured from the first streamed token to the end of
 * the assistant message, so input latency (time to first token) does not reduce
 * the reported tokens/second.
 */
export interface TurnSample {
	/** Output tokens reported by the provider for this turn. */
	outputTokens: number;
	/** Milliseconds from the first token until the assistant message ended. */
	generationMs: number;
	/** Milliseconds from turn start (request start) until the first token. */
	inputLatencyMs: number;
	/** Output tokens per second, excluding input latency. */
	speed: number;
}

export interface SpeedStats {
	/** Number of completed, measurable turns. */
	turns: number;
	/** Most recent completed turn. */
	last: TurnSample | undefined;
	/** Weighted session average: total output tokens / total generation time. */
	averageSpeed: number | undefined;
	/** Arithmetic mean of per-turn input latency. */
	averageInputLatencyMs: number | undefined;
	totalOutputTokens: number;
	totalGenerationMs: number;
	/** Most recent turns, oldest first. */
	recent: readonly TurnSample[];
}

interface CurrentTurn {
	startedAt: number;
	firstTokenAt: number | undefined;
}

const MAX_RECENT_SAMPLES = 8;

export class SpeedTracker {
	private current: CurrentTurn | undefined;
	private lastSample: TurnSample | undefined;
	private turns = 0;
	private totalOutputTokens = 0;
	private totalGenerationMs = 0;
	private totalInputLatencyMs = 0;
	private recent: TurnSample[] = [];

	/** Start a new turn. Any unfinished previous turn is discarded. */
	startTurn(startedAt = Date.now()): void {
		this.current = { startedAt, firstTokenAt: undefined };
	}

	hasCurrent(): boolean {
		return this.current !== undefined;
	}

	hasFirstToken(): boolean {
		return this.current?.firstTokenAt !== undefined;
	}

	/** Record the first streamed token. Later calls for the same turn are ignored. */
	noteFirstToken(at = Date.now()): void {
		if (!this.current || this.current.firstTokenAt !== undefined) return;
		this.current.firstTokenAt = at;
	}

	/**
	 * Finish the current turn and record it when both a first token and output
	 * tokens are available.
	 */
	finish(outputTokens: number, endedAt = Date.now()): TurnSample | undefined {
		const current = this.current;
		this.current = undefined;
		if (!current || current.firstTokenAt === undefined) return undefined;

		const tokens = Math.max(0, Math.floor(outputTokens));
		const generationMs = Math.max(0, endedAt - current.firstTokenAt);
		if (tokens === 0 || generationMs === 0) return undefined;

		const inputLatencyMs = Math.max(0, current.firstTokenAt - current.startedAt);
		const sample: TurnSample = {
			outputTokens: tokens,
			generationMs,
			inputLatencyMs,
			speed: tokens / (generationMs / 1000),
		};

		this.lastSample = sample;
		this.turns += 1;
		this.totalOutputTokens += sample.outputTokens;
		this.totalGenerationMs += sample.generationMs;
		this.totalInputLatencyMs += sample.inputLatencyMs;
		this.recent.push(sample);
		if (this.recent.length > MAX_RECENT_SAMPLES) {
			this.recent.shift();
		}
		return sample;
	}

	reset(): void {
		this.current = undefined;
		this.lastSample = undefined;
		this.turns = 0;
		this.totalOutputTokens = 0;
		this.totalGenerationMs = 0;
		this.totalInputLatencyMs = 0;
		this.recent = [];
	}

	getStats(): SpeedStats {
		return {
			turns: this.turns,
			last: this.lastSample,
			averageSpeed:
				this.totalGenerationMs > 0 ? this.totalOutputTokens / (this.totalGenerationMs / 1000) : undefined,
			averageInputLatencyMs: this.turns > 0 ? this.totalInputLatencyMs / this.turns : undefined,
			totalOutputTokens: this.totalOutputTokens,
			totalGenerationMs: this.totalGenerationMs,
			recent: [...this.recent],
		};
	}

	/** Cheap read for the footer, which renders on every frame. */
	getLastSample(): TurnSample | undefined {
		return this.lastSample;
	}
}

export function formatSpeed(tokensPerSecond: number): string {
	if (!Number.isFinite(tokensPerSecond) || tokensPerSecond <= 0) return "0";
	if (tokensPerSecond >= 100) return Math.round(tokensPerSecond).toString();
	if (tokensPerSecond >= 10) return tokensPerSecond.toFixed(1);
	return tokensPerSecond.toFixed(2);
}

export function formatLatency(ms: number): string {
	if (!Number.isFinite(ms) || ms < 0) return "?";
	if (ms < 1000) return `${Math.round(ms)}ms`;
	if (ms < 60_000) return `${(ms / 1000).toFixed(2)}s`;
	const totalSeconds = Math.round(ms / 1000);
	const minutes = Math.floor(totalSeconds / 60);
	const seconds = totalSeconds % 60;
	return `${minutes}m${seconds.toString().padStart(2, "0")}s`;
}
