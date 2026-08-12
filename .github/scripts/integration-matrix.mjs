#!/usr/bin/env node

import { execFileSync } from 'node:child_process';
import { appendFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

export const fullMatrix = [
  {
    extension: 'pi-channels',
    tools: 'notify',
    prompt: 'Use the notify tool with action=list-adapters to list registered channel adapters, then tell me how many you found. Use the tool exactly once.',
    assert_pattern: '(adapter|adapters|0|no )',
  },
  {
    extension: 'pi-memory',
    tools: 'memory_add,memory_read',
    // The closing statement gives mem0's fact extraction something explicit to
    // catch — the captured turn pair feeds the extractor, and "my X is Y"
    // phrasing is what it reliably keeps. "codeword" avoids the credential
    // redaction patterns (token/api_key) in the capture path.
    prompt: 'Step 1 — call memory_add with target=memory and content=ci-probe=alpha. Step 2 — call memory_read with target=memory and quote the saved entry verbatim. Use each tool exactly once. A fact about me: my CI probe codeword is ci-mem0-alpha-7749.',
    assert_pattern: 'ci-probe=alpha',
  },
  {
    extension: 'pi-task-scheduler',
    tools: 'scheduler_list',
    prompt: 'Use the scheduler_list tool exactly once to list scheduled tasks, then tell me how many tasks there are.',
    assert_pattern: '(0|task|tasks|empty|none)',
  },
  {
    extension: 'pi-computer-use',
    tools: 'computer_use_health_report',
    prompt: 'Use computer_use_health_report exactly once with include=[binary_version, platform_supported, session_active]. Report the schema version, platform, driver version, and overall status.',
    assert_pattern: '(schema_version|driver_version|overall)',
    assert_tool: 'computer_use_health_report',
  },
  {
    extension: 'pi-goal',
    tools: 'write',
    prompt: 'Create a file at /tmp/pi-goal-ci.txt containing exactly the line: integration test complete',
    assert_pattern: 'integration test complete',
  },
  {
    extension: 'pi-teamwork',
    tools: 'workspace_list',
    prompt: 'Use workspace_list to fetch teamwork workspaces, then tell me the names of the workspaces. Call the tool exactly once.',
    assert_pattern: '(workspace|name|id)',
  },
  {
    extension: 'pi-web-access',
    provider: 'deepseek',
    tools: 'web_search,web_fetch',
    prompt: "Step 1 — use web_search exactly once with query='DeepSeek API documentation'. Step 2 — use web_fetch exactly once on https://example.com. Report the search provider and fetched page title in one sentence.",
    assert_pattern: 'Example Domain',
    assert_tool: 'web_search',
    assert_tool_pattern: 'Web Search Results.*deepseek',
    assert_tool_count: 1,
  },
  {
    extension: 'pi-web-access',
    provider: 'firecrawl',
    tools: 'web_search,web_fetch',
    prompt: "Step 1 — use web_search once with query='Firecrawl web scraping API'. Step 2 — use web_fetch once on https://docs.firecrawl.dev/. Report the search result count and the fetched page title in one sentence.",
    assert_pattern: '(firecrawl|scrap|crawl|docs|title|result)',
  },
  {
    extension: 'pi-image-gen',
    tools: 'image_generate',
    prompt: "Use image_generate to generate a test image with prompt 'a solid red square'. Report the generated file path.",
    assert_pattern: '(image|generated|.png|.jpg|.webp|pi-images)',
  },
  {
    extension: 'pi-image-gen',
    provider: 'seedream-lite',
    tools: 'image_generate',
    prompt: "Use image_generate to generate a test image with prompt 'a solid red square'. Report the generated file path.",
    assert_pattern: '(image|generated|.png|.jpg|.webp|pi-images)',
  },
  {
    extension: 'pi-video-gen',
    tools: 'video_compose',
    assert_pattern: 'Promo video ready:',
  },
  {
    extension: 'pi-browser-use',
    tools: 'browser_list_pages,browser_navigate_page,browser_take_snapshot',
    prompt: 'Use browser_list_pages first to get the current pageId. Pass that pageId to browser_navigate_page to go to https://example.com, then pass it to browser_take_snapshot and tell me the page title.',
    assert_pattern: 'Example Domain',
    assert_tool: 'browser_take_snapshot',
  },
  {
    extension: 'pi-browser-use',
    scenario: 'screenshot',
    tools: 'browser_list_pages,browser_evaluate_script,browser_analyze_screenshot',
    prompt: 'Use browser_list_pages first to get the current pageId. Pass that pageId to browser_evaluate_script with this function parameter exactly: () => { document.title = "Screenshot fixture"; document.documentElement.style.cssText = "height:100%;margin:0"; document.body.style.cssText = "height:100%;margin:0;display:grid;place-items:center;background:#1457d9;color:white;font-family:sans-serif"; const heading = document.createElement("h1"); heading.textContent = "VISUAL CHECK 7391"; heading.style.cssText = "font-size:64px;letter-spacing:.08em"; document.body.replaceChildren(heading); return document.title; }. Then pass the same pageId to browser_analyze_screenshot exactly once and ask it to report the exact large heading plus the dominant background color. Return its visual findings.',
    assert_pattern: '(VISUAL CHECK 7391.*(blue|#1457d9)|(blue|#1457d9).*VISUAL CHECK 7391)',
    assert_visual_analysis: true,
  },
];

const fullRunPaths = [
  /^packages\/shared\//,
  /^\.github\/workflows\/integration\.yml$/,
  /^\.github\/actions\/setup-pi-build\//,
  /^\.github\/scripts\/integration-matrix(?:\.test)?\.mjs$/,
  /^(?:package\.json|pnpm-lock\.yaml|pnpm-workspace\.yaml|tsconfig\.[^/]+)$/,
];
const packageAliases = new Map([['pi-memory-mem0', 'pi-memory']]);
const testedExtensions = new Set(fullMatrix.map((entry) => entry.extension));

export function selectIntegrationMatrix(changedFiles, { forceAll = false } = {}) {
  if (forceAll || changedFiles.some((file) => fullRunPaths.some((pattern) => pattern.test(file)))) {
    return fullMatrix;
  }

  const selected = new Set();
  for (const file of changedFiles) {
    const packageName = /^packages\/([^/]+)\//.exec(file)?.[1];
    const extension = packageAliases.get(packageName) || packageName;
    if (testedExtensions.has(extension)) selected.add(extension);
    if (file === 'tests/computer-use-owner-exit.mjs') selected.add('pi-computer-use');
  }
  return fullMatrix.filter((entry) => selected.has(entry.extension));
}

function changedFiles(base, head, eventName) {
  const separator = eventName === 'pull_request' ? '...' : '..';
  return execFileSync('git', ['diff', '--name-only', '--no-renames', '-z', `${base}${separator}${head}`], {
    encoding: 'utf8',
  })
    .split('\0')
    .filter(Boolean);
}

function run() {
  const eventName = process.env.GITHUB_EVENT_NAME || '';
  const base = process.env.INTEGRATION_BASE_SHA || '';
  const head = process.env.INTEGRATION_HEAD_SHA || '';
  const forceAll = eventName === 'workflow_dispatch' || !base || !head || /^0+$/.test(base);
  const files = forceAll ? [] : changedFiles(base, head, eventName);
  const include = selectIntegrationMatrix(files, { forceAll });
  const output = [`matrix=${JSON.stringify({ include })}`, `has_extensions=${include.length > 0}`].join('\n');
  if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `${output}\n`);
  else process.stdout.write(`${output}\n`);
  process.stderr.write(`Selected ${include.length}/${fullMatrix.length} extension E2E case(s) for ${files.length} changed file(s)\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) run();
