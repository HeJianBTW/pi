/** Vision model used by the optional analyze_screenshot tool. */
export interface VisionModelConfig {
  provider: string;
  model: string;
  apiKey?: string;
  baseUrl?: string;
}

/** Configuration for the chrome-devtools-mcp upstream process. */
export interface BrowserUseConfig {
  headless?: boolean;
  channel?: 'canary' | 'dev' | 'beta' | 'stable';
  browserUrl?: string;
  wsEndpoint?: string;
  wsHeaders?: string;
  executablePath?: string;
  viewport?: string;
  isolated?: boolean;
  userDataDir?: string;
  autoConnect?: boolean;

  categoryPerformance?: boolean;
  categoryNetwork?: boolean;
  categoryEmulation?: boolean;
  categoryExtensions?: boolean;

  experimentalVision?: boolean;
  experimentalScreencast?: boolean;
  experimentalMemory?: boolean;

  visionModel?: VisionModelConfig;

  usageStatistics?: boolean;
  performanceCrux?: boolean;

  slim?: boolean;
  extraArgs?: string[];
}

const DEFAULTS: Partial<BrowserUseConfig> = {
  categoryPerformance: false,
  categoryNetwork: true,
  categoryEmulation: true,
  categoryExtensions: false,
  experimentalVision: true,
  experimentalScreencast: false,
  experimentalMemory: false,
  usageStatistics: false,
  performanceCrux: false,
};

/** Merge user config over sane defaults. */
export function resolveConfig(config?: BrowserUseConfig): BrowserUseConfig {
  return { ...DEFAULTS, ...config };
}

/** Convert config into CLI flags for the chrome-devtools-mcp subprocess. */
export function configToArgs(config: BrowserUseConfig): string[] {
  const args: string[] = [];
  const resolved = resolveConfig(config);

  if (resolved.headless) args.push('--headless');
  if (resolved.channel) args.push(`--channel=${resolved.channel}`);
  if (resolved.browserUrl) args.push(`--browser-url=${resolved.browserUrl}`);
  if (resolved.wsEndpoint) args.push(`--ws-endpoint=${resolved.wsEndpoint}`);
  if (resolved.wsHeaders) args.push(`--ws-headers=${resolved.wsHeaders}`);
  if (resolved.executablePath) args.push(`--executable-path=${resolved.executablePath}`);
  if (resolved.viewport) args.push(`--viewport=${resolved.viewport}`);
  if (resolved.isolated) args.push('--isolated');
  if (resolved.userDataDir) args.push(`--user-data-dir=${resolved.userDataDir}`);
  if (resolved.autoConnect) args.push('--auto-connect');
  if (resolved.slim) args.push('--slim');

  if (resolved.categoryPerformance === false) args.push('--category-performance=false');
  if (resolved.categoryNetwork === false) args.push('--category-network=false');
  if (resolved.categoryEmulation === false) args.push('--category-emulation=false');
  if (resolved.categoryExtensions === true) args.push('--category-extensions=true');

  if (resolved.experimentalVision) args.push('--experimental-vision');
  if (resolved.experimentalScreencast) args.push('--experimental-screencast');
  if (resolved.experimentalMemory) args.push('--experimental-memory');

  if (resolved.usageStatistics === false) args.push('--no-usage-statistics');
  if (resolved.performanceCrux === false) args.push('--no-performance-crux');

  if (resolved.extraArgs) args.push(...resolved.extraArgs);

  return args;
}
