/**
 * pi-speed: add output speed and input latency to pi's footer stats line.
 *
 * The built-in footer is replaced with the same layout plus:
 *   42.3t/s 1.24s
 *
 * - 42.3t/s is the latest turn's average output speed (tokens / generation time).
 * - 1.24s is the latest turn's input latency / time to first token.
 *
 * Run `/speed` for session averages, or `/speed reset` to start over.
 */

import { isAbsolute, relative, resolve, sep } from "node:path";
import type { AssistantMessage, Usage } from "@earendil-works/pi-ai";
import type {
	ContextUsage,
	ExtensionAPI,
	ExtensionContext,
	ReadonlyFooterDataProvider,
} from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import type { Component } from "@earendil-works/pi-tui";
import { formatLatency, formatSpeed, SpeedTracker } from "../src/tracker.ts";

interface UsageTotals {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	cost: number;
}

interface LatestAssistant {
	model: string;
	thinkingLevel: string | undefined;
}

interface SessionStats {
	sessionManager: ExtensionContext["sessionManager"];
	sessionId: string;
	leafId: string | null;
	entryCount: number;
	model: ExtensionContext["model"];
	totals: UsageTotals;
	latestCacheHitRate: number | undefined;
	latestAssistant: LatestAssistant | undefined;
	contextUsage: ContextUsage | undefined;
}

function createUsageTotals(): UsageTotals {
	return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 };
}

function addUsageToTotals(totals: UsageTotals, usage: Usage): void {
	totals.input += usage.input;
	totals.output += usage.output;
	totals.cacheRead += usage.cacheRead;
	totals.cacheWrite += usage.cacheWrite;
	totals.cost += usage.cost.total;
}

/** Same compact token formatting as the built-in footer. */
function formatTokens(count: number): string {
	if (count < 1000) return count.toString();
	if (count < 10000) return `${(count / 1000).toFixed(1)}k`;
	if (count < 1000000) return `${Math.round(count / 1000)}k`;
	if (count < 10000000) return `${(count / 1000000).toFixed(1)}M`;
	return `${Math.round(count / 1000000)}M`;
}

/** Same path shortening as the built-in footer. */
function formatCwdForFooter(cwd: string, home: string | undefined): string {
	if (!home) return cwd;
	const resolvedCwd = resolve(cwd);
	const resolvedHome = resolve(home);
	const relativeToHome = relative(resolvedHome, resolvedCwd);
	const isInsideHome =
		relativeToHome === "" ||
		(relativeToHome !== ".." && !relativeToHome.startsWith(`..${sep}`) && !isAbsolute(relativeToHome));
	if (!isInsideHome) return cwd;
	return relativeToHome === "" ? "~" : `~${sep}${relativeToHome}`;
}

/** Extension statuses must stay on one line. */
function sanitizeStatusText(text: string): string {
	return text
		.replace(/[\r\n\t]/g, " ")
		.replace(/ +/g, " ")
		.trim();
}

function getEntryCount(manager: ExtensionContext["sessionManager"]): number {
	const withCount = manager as ExtensionContext["sessionManager"] & { getEntryCount?: () => number };
	return withCount.getEntryCount ? withCount.getEntryCount() : manager.getEntries().length;
}

function isUsingSubscription(ctx: ExtensionContext, provider: string | undefined): boolean {
	if (!provider) return false;
	if (provider === "kimi-coding") return true;
	try {
		// ModelRegistry is a public facade over ModelRuntime; the built-in footer
		// asks the runtime directly for its subscription-backed auth check.
		const registry = ctx.modelRegistry as unknown as {
			runtime?: { isUsingSubscription?: (providerId: string) => boolean };
		};
		return registry.runtime?.isUsingSubscription?.(provider) === true;
	} catch {
		return false;
	}
}

const FIRST_OUTPUT_EVENT_TYPES = new Set([
	"text_start",
	"text_delta",
	"thinking_start",
	"thinking_delta",
	"toolcall_start",
	"toolcall_delta",
]);

class SpeedFooter implements Component {
	private cache: SessionStats | undefined;
	private readonly ctx: ExtensionContext;
	private readonly footerData: ReadonlyFooterDataProvider;
	private readonly tracker: SpeedTracker;
	private readonly getAutoCompactEnabled: () => boolean;
	private readonly disposeBranchSubscription: () => void;

	constructor(
		ctx: ExtensionContext,
		footerData: ReadonlyFooterDataProvider,
		tracker: SpeedTracker,
		getAutoCompactEnabled: () => boolean,
		disposeBranchSubscription: () => void,
	) {
		this.ctx = ctx;
		this.footerData = footerData;
		this.tracker = tracker;
		this.getAutoCompactEnabled = getAutoCompactEnabled;
		this.disposeBranchSubscription = disposeBranchSubscription;
	}

	dispose(): void {
		this.disposeBranchSubscription();
	}

	invalidate(): void {
		// Stats are cached by session identity/entry count/model, so no explicit
		// invalidation is needed here.
	}

	private getSessionStats(): SessionStats {
		const ctx = this.ctx;
		const sessionManager = ctx.sessionManager;
		const sessionId = sessionManager.getSessionId();
		const leafId = sessionManager.getLeafId();
		const entryCount = getEntryCount(sessionManager);
		const model = ctx.model;

		const cached = this.cache;
		if (
			cached &&
			cached.sessionManager === sessionManager &&
			cached.sessionId === sessionId &&
			cached.leafId === leafId &&
			cached.entryCount === entryCount &&
			cached.model === model
		) {
			return cached;
		}

		const totals = createUsageTotals();
		let latestCacheHitRate: number | undefined;
		let latestAssistant: LatestAssistant | undefined;

		for (const entry of sessionManager.getEntries()) {
			if (entry.type === "usage") {
				addUsageToTotals(totals, entry.usage);
			} else if (entry.type === "message" && entry.message.role === "assistant") {
				const usage = entry.message.usage;
				addUsageToTotals(totals, usage);
				const promptTokens = usage.input + usage.cacheRead + usage.cacheWrite;
				latestCacheHitRate = promptTokens > 0 ? (usage.cacheRead / promptTokens) * 100 : undefined;
				latestAssistant = {
					model: entry.message.model,
					thinkingLevel: entry.message.thinkingLevel,
				};
			} else if (entry.type === "message" && entry.message.role === "toolResult" && entry.message.usage) {
				addUsageToTotals(totals, entry.message.usage);
			} else if ((entry.type === "branch_summary" || entry.type === "compaction") && entry.usage) {
				addUsageToTotals(totals, entry.usage);
			}
		}

		this.cache = {
			sessionManager,
			sessionId,
			leafId,
			entryCount,
			model,
			totals,
			latestCacheHitRate,
			latestAssistant,
			contextUsage: ctx.getContextUsage(),
		};
		return this.cache;
	}

	render(width: number): string[] {
		const ctx = this.ctx;
		const theme = ctx.ui.theme;
		const model = ctx.model;
		const { totals, latestCacheHitRate, latestAssistant, contextUsage } = this.getSessionStats();

		const contextWindow = contextUsage?.contextWindow ?? model?.contextWindow ?? 0;
		const contextPercentValue = contextUsage?.percent ?? 0;
		const contextPercent = contextUsage?.percent == null ? "?" : contextUsage.percent.toFixed(1);

		let pwd = formatCwdForFooter(
			ctx.sessionManager.getCwd(),
			process.env.HOME || process.env.USERPROFILE,
		);
		const branch = this.footerData.getGitBranch();
		if (branch) pwd = `${pwd} (${branch})`;
		const sessionName = ctx.sessionManager.getSessionName();
		if (sessionName) pwd = `${pwd} • ${sessionName}`;

		const statsParts: string[] = [];
		if (totals.input) statsParts.push(`↑${formatTokens(totals.input)}`);
		if (totals.output) statsParts.push(`↓${formatTokens(totals.output)}`);
		if (totals.cacheRead) statsParts.push(`R${formatTokens(totals.cacheRead)}`);
		if (totals.cacheWrite) statsParts.push(`W${formatTokens(totals.cacheWrite)}`);
		if ((totals.cacheRead > 0 || totals.cacheWrite > 0) && latestCacheHitRate !== undefined) {
			statsParts.push(`CH${latestCacheHitRate.toFixed(1)}%`);
		}

		const usingSubscription = isUsingSubscription(ctx, model?.provider);
		if (totals.cost || usingSubscription) {
			statsParts.push(`$${totals.cost.toFixed(3)}${usingSubscription ? " (sub)" : ""}`);
		}

		const latestTurn = this.tracker.getLastSample();
		if (latestTurn) {
			statsParts.push(`${formatSpeed(latestTurn.speed)}t/s`);
			statsParts.push(formatLatency(latestTurn.inputLatencyMs));
		}

		let contextPercentStr: string;
		const autoIndicator = this.getAutoCompactEnabled() ? " (auto)" : "";
		const contextPercentDisplay =
			contextPercent === "?"
				? `?/${formatTokens(contextWindow)}${autoIndicator}`
				: `${contextPercent}%/${formatTokens(contextWindow)}${autoIndicator}`;
		if (contextPercentValue > 90) {
			contextPercentStr = theme.fg("error", contextPercentDisplay);
		} else if (contextPercentValue > 70) {
			contextPercentStr = theme.fg("warning", contextPercentDisplay);
		} else {
			contextPercentStr = contextPercentDisplay;
		}
		statsParts.push(contextPercentStr);

		let statsLeft = statsParts.join(" ");
		let statsLeftWidth = visibleWidth(statsLeft);
		if (statsLeftWidth > width) {
			statsLeft = truncateToWidth(statsLeft, width, "...");
			statsLeftWidth = visibleWidth(statsLeft);
		}

		let rightSideWithoutProvider = model?.id || "no-model";
		if (model?.reasoning) {
			const thinkingLevel = ctx.thinkingLevel || "off";
			rightSideWithoutProvider =
				thinkingLevel === "off" ? `${model.id} • thinking off` : `${model.id} • ${thinkingLevel}`;
		}

		// A virtual model routes each request; show where the latest response went.
		if (model?.api === "pi-virtual" && latestAssistant) {
			const level = latestAssistant.thinkingLevel ? ` • ${latestAssistant.thinkingLevel}` : "";
			rightSideWithoutProvider += ` → ${latestAssistant.model}${level}`;
		}

		const minPadding = 2;
		let rightSide = rightSideWithoutProvider;
		if (this.footerData.getAvailableProviderCount() > 1 && model) {
			rightSide = `(${model.provider}) ${rightSideWithoutProvider}`;
			if (statsLeftWidth + minPadding + visibleWidth(rightSide) > width) {
				rightSide = rightSideWithoutProvider;
			}
		}

		const rightSideWidth = visibleWidth(rightSide);
		let statsLine: string;
		if (statsLeftWidth + minPadding + rightSideWidth <= width) {
			const padding = " ".repeat(width - statsLeftWidth - rightSideWidth);
			statsLine = statsLeft + padding + rightSide;
		} else {
			const availableForRight = width - statsLeftWidth - minPadding;
			if (availableForRight > 0) {
				const truncatedRight = truncateToWidth(rightSide, availableForRight, "");
				const truncatedRightWidth = visibleWidth(truncatedRight);
				const padding = " ".repeat(Math.max(0, width - statsLeftWidth - truncatedRightWidth));
				statsLine = statsLeft + padding + truncatedRight;
			} else {
				statsLine = statsLeft;
			}
		}

		const dimStatsLeft = theme.fg("dim", statsLeft);
		const remainder = statsLine.slice(statsLeft.length);
		const dimRemainder = theme.fg("dim", remainder);

		const pwdLine = truncateToWidth(theme.fg("dim", pwd), width, theme.fg("dim", "..."));
		const lines = [pwdLine, dimStatsLeft + dimRemainder];

		const extensionStatuses = this.footerData.getExtensionStatuses();
		if (extensionStatuses.size > 0) {
			const statusLine = Array.from(extensionStatuses.entries())
				.sort(([a], [b]) => a.localeCompare(b))
				.map(([, text]) => sanitizeStatusText(text))
				.join(" ");
			lines.push(truncateToWidth(statusLine, width, theme.fg("dim", "...")));
		}

		return lines;
	}
}

export default function (pi: ExtensionAPI) {
	const tracker = new SpeedTracker();
	let requestFooterRender: (() => void) | undefined;

	pi.on("session_start", async (_event, ctx) => {
		tracker.reset();
		requestFooterRender = undefined;
		if (ctx.mode !== "tui") return;

		ctx.ui.setFooter((tui, _theme, footerData) => {
			const unsubscribe = footerData.onBranchChange(() => tui.requestRender());
			requestFooterRender = () => tui.requestRender();
			const getAutoCompactEnabled = () => {
				try {
					return pi.getSettings().compaction?.enabled !== false;
				} catch {
					return true;
				}
			};
			return new SpeedFooter(ctx, footerData, tracker, getAutoCompactEnabled, unsubscribe);
		});
	});

	pi.on("session_shutdown", async () => {
		requestFooterRender = undefined;
	});

	pi.on("turn_start", async (event) => {
		tracker.startTurn(event.timestamp);
	});

	pi.on("message_start", async (event) => {
		if (event.message.role !== "assistant" || tracker.hasCurrent()) return;
		// Defensive: recover timing if the extension was loaded mid-turn.
		tracker.startTurn((event.message as AssistantMessage).timestamp || Date.now());
	});

	pi.on("message_update", async (event) => {
		if (event.message.role !== "assistant") return;
		if (!FIRST_OUTPUT_EVENT_TYPES.has(event.assistantMessageEvent.type)) return;
		if (tracker.hasFirstToken()) return;
		if (!tracker.hasCurrent()) {
			tracker.startTurn((event.message as AssistantMessage).timestamp || Date.now());
		}
		tracker.noteFirstToken(Date.now());
	});

	pi.on("message_end", async (event) => {
		if (event.message.role !== "assistant") return;
		const usage = (event.message as AssistantMessage).usage;
		const sample = tracker.finish(usage?.output ?? 0, Date.now());
		if (sample) requestFooterRender?.();
	});

	pi.on("turn_end", async (event) => {
		// Fallback when no message_end reached us (for example an aborted stream).
		if (event.message.role !== "assistant" || !tracker.hasCurrent()) return;
		const usage = (event.message as AssistantMessage).usage;
		const sample = tracker.finish(usage?.output ?? 0, Date.now());
		if (sample) requestFooterRender?.();
	});

	pi.registerCommand("speed", {
		description: "Show per-turn output speed and input latency stats",
		handler: async (args, ctx) => {
			const action = args.trim().toLowerCase();
			if (action === "reset" || action === "clear") {
				tracker.reset();
				requestFooterRender?.();
				ctx.ui.notify("Speed statistics reset.", "info");
				return;
			}

			const stats = tracker.getStats();
			if (stats.turns === 0 || !stats.last) {
				ctx.ui.notify("No completed turns measured yet.", "info");
				return;
			}

			const last = stats.last;
			const averageSpeed =
				stats.averageSpeed === undefined ? "n/a" : `${formatSpeed(stats.averageSpeed)} tok/s`;
			const averageLatency =
				stats.averageInputLatencyMs === undefined ? "n/a" : formatLatency(stats.averageInputLatencyMs);
			const turns = `${stats.turns} turn${stats.turns === 1 ? "" : "s"}`;

			ctx.ui.notify(
				[
					`Speed: last ${formatSpeed(last.speed)} tok/s · TTFT ${formatLatency(last.inputLatencyMs)} · ${formatTokens(last.outputTokens)} tok in ${formatLatency(last.generationMs)}`,
					`Session: ${turns} · avg ${averageSpeed} · avg TTFT ${averageLatency} · total ${formatTokens(stats.totalOutputTokens)} tok`,
				].join("\n"),
				"info",
			);
		},
	});
}
