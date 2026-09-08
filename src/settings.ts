import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

import type { TokenSpeedConfig } from "./config-types";
import { STATUS_KEY } from "./constants";
import {
  COLOR_BLAZING,
  COLOR_FAST,
  COLOR_MEDIUM,
  COLOR_SLOW,
  COUNT_STRATEGY,
  DEFAULT_ICON,
  DISPLAY_MODE,
  END_TPS_BEHAVIOR,
  GRAPH_ENABLED,
  GRAPH_HEIGHT,
  GRAPH_HISTORY_MS,
  GRAPH_SAMPLE_INTERVAL,
  INCLUDE_SUBAGENTS,
  SUBAGENT_RETENTION_MS,
  SUBAGENT_STALE_MS,
  SLIDING_WINDOW,
  TPS_THRESHOLD_BLAZING,
  TPS_THRESHOLD_FAST,
  TPS_THRESHOLD_MEDIUM,
  TPS_THRESHOLD_SLOW,
  UPDATE_INTERVAL,
  USE_PROVIDER_TOKENS,
} from "./defaults";
import { Validator } from "./validation";

/**
 * Manages TokenSpeed configuration: defaults, user settings, caching,
 * and persistence to ~/.pi/agent/settings.json.
 *
 * Delegates validation to the `Validator` utility class.
 *
 * Use the exported `settings` singleton — do not instantiate directly.
 *
 * Decode counting behavior: text, thinking, and every tool-call delta are
 * merged into one estimated model-decode stream. Tool execution time itself is
 * excluded by the event lifecycle rather than by filtering tool names.
 */
export class Settings {
  private cachedConfig: TokenSpeedConfig | null = null;
  private cachedErrors: string[] = [];

  /**
   * @internal Use the exported `settings` singleton instead.
   */
  constructor(
    private readonly settingsPath = join(getAgentDir(), "settings.json"),
  ) {}

  /**
   * Retrieves the default configuration object.
   *
   * @returns The default configuration.
   */
  getDefaultConfig(): TokenSpeedConfig {
    return {
      tpsSlow: TPS_THRESHOLD_SLOW,
      tpsMedium: TPS_THRESHOLD_MEDIUM,
      tpsFast: TPS_THRESHOLD_FAST,
      tpsBlazing: TPS_THRESHOLD_BLAZING,
      colorSlow: COLOR_SLOW,
      colorMedium: COLOR_MEDIUM,
      colorFast: COLOR_FAST,
      colorBlazing: COLOR_BLAZING,
      slidingWindow: SLIDING_WINDOW,
      display: DISPLAY_MODE,
      useProviderTokens: USE_PROVIDER_TOKENS,
      countStrategy: COUNT_STRATEGY,
      endTpsBehavior: END_TPS_BEHAVIOR,
      icon: DEFAULT_ICON,
      updateInterval: UPDATE_INTERVAL,
      graphEnabled: GRAPH_ENABLED,
      graphHistoryMs: GRAPH_HISTORY_MS,
      graphSampleInterval: GRAPH_SAMPLE_INTERVAL,
      graphHeight: GRAPH_HEIGHT,
      includeSubagents: INCLUDE_SUBAGENTS,
      subagentStaleMs: SUBAGENT_STALE_MS,
      subagentRetentionMs: SUBAGENT_RETENTION_MS,
    };
  }

  /**
   * Initializes the config values
   */
  async initialize(): Promise<TokenSpeedConfig> {
    const defaults = this.getDefaultConfig();
    const userSettings = await this.readUserSettings();

    const merged = { ...defaults, ...userSettings };
    const { config, errors } = Validator.validate(merged);
    this.cachedConfig = config;
    this.cachedErrors = errors;

    return this.cachedConfig;
  }

  /**
   * Returns the cached configuration, or defaults if not yet initialized.
   */
  getConfig(): TokenSpeedConfig {
    return this.cachedConfig || this.getDefaultConfig();
  }

  /**
   * Returns validation errors from the last config resolution.
   * Only relevant at initialization time (e.g., to show warnings).
   */
  getErrors(): string[] {
    return this.cachedErrors;
  }

  /**
   * Writes a partial TokenSpeedConfig and updates the cache.
   */
  async setConfig(partial: Partial<TokenSpeedConfig>): Promise<void> {
    await this.writeUserSettings(partial);
    const current = this.cachedConfig || this.getDefaultConfig();
    this.cachedConfig = { ...current, ...partial };
  }

  /**
   * Reads and parses the settings file, returning an empty object on failure.
   */
  private async readSettings(): Promise<Record<string, unknown>> {
    try {
      const raw = await readFile(this.settingsPath, "utf-8");
      return JSON.parse(raw) as Record<string, unknown>;
    } catch {
      return {};
    }
  }

  /**
   * Writes a JSON object to the settings file with 2-space indentation.
   */
  private async writeSettings(data: Record<string, unknown>): Promise<void> {
    await writeFile(this.settingsPath, JSON.stringify(data, null, 2), "utf-8");
  }

  /**
   * Reads ~/.pi/agent/settings.json and extracts the "tokenSpeed" settings block.
   *
   * @returns The TokenSpeed settings object.
   */
  private async readUserSettings(): Promise<TokenSpeedConfig> {
    const settings = await this.readSettings();
    return (settings[STATUS_KEY] || {}) as TokenSpeedConfig;
  }

  /**
   * Writes a partial TokenSpeedConfig to ~/.pi/agent/settings.json,
   * merging it with existing values.
   *
   * @param partial The partial TokenSpeedConfig to write.
   */
  private async writeUserSettings(
    partial: Partial<TokenSpeedConfig>,
  ): Promise<void> {
    const settings = await this.readSettings();
    const current = (settings[STATUS_KEY] as Record<string, unknown>) || {};
    settings[STATUS_KEY] = { ...current, ...partial };

    await this.writeSettings(settings);
  }
}

/**
 * Shared singleton instance used across the extension.
 */
export const settings = new Settings();
