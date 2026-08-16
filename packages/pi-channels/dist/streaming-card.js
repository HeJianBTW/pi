// Streaming Feishu card builder for pi-channels.
// Card layout mirrors the hermes-feishu-streaming-card project:
// - schema 2.0 card with body.elements
// - native collapsible_panel for the "思考与工具" timeline (collapsed by default)
// - footer: 已完成 · <duration> · <model> · ↑in · ↓out · ctx used/max pct%

const MAIN_CONTENT_CHUNK_CHARS = 2400;
const MAX_REASONING_CHARS = 180;
const MAX_TOOL_RESULT_CHARS = 160;
const MAX_TIMELINE_ITEMS = 6;
const MAX_CARD_BYTES = 28_000;
const MAX_CARD_ELEMENTS = 200;
const MAX_CARD_TABLES = 5;
const SPINNER_FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];
const MODEL_COLORS = [
    [['gpt-', 'o1', 'o3'], 'blue'],
    [['claude-'], 'orange'],
    [['deepseek-', 'deepseek/'], 'indigo'],
    [['kimi-', 'kimi/', 'moonshot-'], 'purple'],
    [['glm-'], 'green'],
    [['hy3', 'tencent/', 'hunyuan'], 'teal'],
];
const SENSITIVE_KEY_RE = /(token|secret|password|api[-_]?key|app[-_]?secret|authorization|credential)/i;
const FRIENDLY_SERVER_LABELS = {
    'fast-note-sync': 'Obsidian',
    tavily: 'Tavily',
    beecount: 'BeeCount',
    whoop: 'WHOOP',
    '12306': '12306',
    icloud_calendar: 'iCloud 日历',
};
const FRIENDLY_TOOL_LABELS = {
    read: '读取文件',
    edit: '修改文件',
    write: '写入文件',
    mcp: '调用 MCP',
    beecount_get_ledger_stats: '读取记账统计',
    beecount_get_active_ledger: '读取默认账本',
    beecount_list_transactions: '查询记账记录',
    beecount_create_transaction: '新增记账',
    beecount_update_transaction: '修改记账',
    beecount_delete_transaction: '删除记账',
    fast_note_sync_note_list: '读取 Obsidian 笔记列表',
    fast_note_sync_note_get: '读取 Obsidian 笔记',
    fast_note_sync_note_create_or_update: '写入 Obsidian 笔记',
    tavily_tavily_search: '网页搜索',
    tavily_tavily_extract: '网页提取',
    whoop_get_today: '查询 WHOOP 今日状态',
    whoop_get_trend: '查询 WHOOP 趋势',
    whoop_get_sleep_collection: '查询 WHOOP 睡眠',
    whoop_get_recovery_collection: '查询 WHOOP 恢复',
    whoop_get_workout_collection: '查询 WHOOP 训练',
    calendar_list: '读取日历',
    calendar_create: '创建日历',
    calendar_update: '修改日历',
    event_search: '搜索日程',
    event_get: '读取日程',
    event_create: '创建日程',
    event_update: '修改日程',
    event_delete: '删除日程',
    get_tickets: '查询 12306 车票',
    get_interline_tickets: '查询 12306 中转方案',
};

function stripControl(text) {
    return (text ?? '').replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '');
}
function truncate(text, max) {
    const clean = stripControl(text);
    if (clean.length <= max)
        return clean;
    return clean.slice(0, max) + '…';
}
function escapeMd(text) {
    return String(text ?? '').replace(/[|\\]/g, (ch) => `\\${ch}`);
}
function markdownClean(text) {
    // Feishu lark_md does not render "- "/"* " list markers reliably; use literal bullets.
    return String(text ?? '').replace(/^[-*]\s+/gm, '• ');
}
function spinnerFrame() {
    return SPINNER_FRAMES[Math.floor(Date.now() / 125) % SPINNER_FRAMES.length];
}
function formatDuration(seconds) {
    const total = Math.max(0, Math.round(seconds));
    const minutes = Math.floor(total / 60);
    const rest = total % 60;
    const hours = Math.floor(minutes / 60);
    if (hours)
        return `${hours}h${minutes % 60}m${rest}s`;
    if (minutes)
        return `${minutes}m${rest}s`;
    return `${rest}s`;
}
function formatCount(value) {
    const n = typeof value === 'number' && Number.isFinite(value) ? Math.max(0, Math.round(value)) : 0;
    if (n >= 1_000_000)
        return formatScaled(n, 1_000_000, 'm');
    if (n >= 1_000)
        return formatScaled(n, 1_000, 'k');
    return String(n);
}
function formatScaled(value, factor, suffix) {
    const scaled = value / factor;
    if (scaled >= 100 || Number.isInteger(scaled))
        return `${Math.round(scaled)}${suffix}`;
    return `${scaled.toFixed(1).replace(/\.0$/, '')}${suffix}`;
}
function coloredModel(model) {
    const safe = escapeMd(String(model || ''));
    const normalized = String(model || '').toLowerCase();
    for (const [prefixes, color] of MODEL_COLORS) {
        if (prefixes.some((prefix) => normalized.startsWith(prefix))) {
            return `<font color="${color}">${safe}</font>`;
        }
    }
    return safe;
}
function redactValue(value) {
    if (Array.isArray(value))
        return value.map(redactValue);
    if (value && typeof value === 'object') {
        const out = {};
        for (const [key, item] of Object.entries(value)) {
            out[key] = SENSITIVE_KEY_RE.test(key) ? '[REDACTED]' : redactValue(item);
        }
        return out;
    }
    return value;
}
function extractText(value) {
    if (Array.isArray(value))
        return value.map(extractText).filter((item) => item !== undefined && item !== null && item !== '').join('\n');
    if (value && typeof value === 'object') {
        if (value.content !== undefined)
            return extractText(value.content);
        if (value.text !== undefined)
            return extractText(value.text);
        try {
            return JSON.stringify(value);
        }
        catch {
            return String(value);
        }
    }
    return value;
}
function summarizeValue(value, max = 600) {
    try {
        const extracted = extractText(value);
        if (extracted === undefined || extracted === null || extracted === '')
            return '';
        return truncate(String(extracted).replace(/\s+/g, ' '), max);
    }
    catch {
        return '';
    }
}
function summarizeArgs(args) {
    try {
        if (args === undefined || args === null)
            return '';
        const redacted = redactValue(args);
        const raw = typeof redacted === 'string' ? redacted : JSON.stringify(redacted);
        return truncate(raw.replace(/\s+/g, ' '), 200);
    }
    catch {
        return '';
    }
}
export function chunkMarkdown(text, max = MAIN_CONTENT_CHUNK_CHARS) {
    const clean = stripControl(text);
    if (clean.length <= max)
        return [clean];
    const chunks = [];
    let current = '';
    let inFence = false;
    for (const line of clean.split('\n')) {
        const isFence = /^\s*```/.test(line);
        // A fenced block must be one card element: Feishu otherwise renders a
        // broken code block when an update happens at its split point.
        if (isFence && !inFence && current) {
            chunks.push(current);
            current = '';
        }
        const next = current ? `${current}\n${line}` : line;
        if (!inFence && !isFence && current && next.length > max) {
            chunks.push(current);
            current = line;
        }
        else {
            current = next;
        }
        if (isFence)
            inFence = !inFence;
        if (!inFence && current.length >= max) {
            chunks.push(current);
            current = '';
        }
    }
    if (current)
        chunks.push(current);
    return chunks;
}
function statusTemplate(state) {
    if (state.status === 'error')
        return 'red';
    if (state.status === 'interrupted')
        return 'orange';
    if (state.status === 'done')
        return 'green';
    return 'blue';
}
function statusLabel(state) {
    if (state.status === 'error')
        return '❌ 失败';
    if (state.status === 'interrupted')
        return '⚠️ 已中断（重启）';
    if (state.status === 'done')
        return '✅ 已完成';
    if (state.status === 'tool') {
        const running = [...state.tools].reverse().find((t) => t.state === 'running');
        return running ? `🛠 执行 ${running.name}` : '🛠 执行工具';
    }
    if (state.status === 'answering')
        return '✍️ 回答中';
    return '💭 思考中';
}
function renderReasoningEntry(entry) {
    const lines = [`**${entry.title}** · ${entry.status === 'running' ? '进行中' : '已完成'}`];
    if (entry.content) {
        lines.push(truncate(markdownClean(entry.content), MAX_REASONING_CHARS));
    }
    return lines.join('\n');
}
export function renderToolRow(tool) {
    const rawName = friendlyToolName(tool.name, tool.args).replace(/`/g, '');
    // A semantic MCP name contains underscores (for example mcp__foo__bar).
    // Feishu Card Markdown ignores backslash escaping inside a coloured font.
    // A zero-width separator prevents consecutive underscores being parsed as
    // emphasis while preserving the exact visual identifier for the reader.
    const name = rawName
        .replace(/_/g, '_\u200B')
        .replace(/[*`]/g, '');
    const state = String(tool.state || 'running').toLowerCase();
    let headline;
    let color;
    if (state === 'error' || state === 'failed') {
        color = 'red';
        headline = `✕ **${name}** · 失败`;
    }
    else if (state === 'done' || state === 'completed' || state === 'success') {
        color = 'green';
        // Keep the terminal label on every tool row. Besides matching the
        // Hermes timeline grammar, it makes a successful direct tool call
        // distinguishable from a merely displayed name in Feishu's collapsed
        // panel.
        headline = tool.isShellSummary
            ? `✓ **${name}**`
            : `✓ **${name}** · 已完成`;
    }
    else {
        color = 'blue';
        headline = `${spinnerFrame()} **${name}** · 进行中`;
    }
    const lines = [`<font color="${color}">${headline}</font>`];
    const detail = Object.prototype.hasOwnProperty.call(tool, 'detail')
        ? truncate(tool.detail || '', MAX_TOOL_RESULT_CHARS)
        : summarizeArgs(tool.args);
    if (detail) {
        for (const line of String(detail).split('\n')) {
            lines.push(`<font color="grey">　${escapeMd(line)}</font>`);
        }
    }
    return lines.join('\n');
}

export const MAIN_CONTENT_ID = 'main_content';

export function mainContentText(state) {
    if (state.status === 'error') {
        return state.errorText || '出错了';
    }
    if (state.answer) {
        return markdownClean(state.answer);
    }
    // During thinking/tool phases there is no answer yet: show a neutral
    // placeholder instead of leaking the reasoning text into the body.
    if (state.status === 'tool') {
        return `${spinnerFrame()} 正在执行工具…`;
    }
    return `${spinnerFrame()} 正在思考…`;
}

export function createCardState(options) {
    return {
        status: 'thinking',
        answer: '',
        reasonings: [],
        process: [],
        tools: [],
        timeline: [],
        toolIndex: new Map(),
        toolCount: 0,
        model: options?.model || '',
        provider: options?.provider || '',
        contextWindow: options?.contextWindow || 0,
        startedAt: Date.now(),
        errorText: '',
        usage: null,
        outputTotal: 0,
        cost: 0,
    };
}

export function applyCardEvent(state, event) {
    // returns 'text' (main content changed, cheap element update),
    // 'full' (header/timeline/footer changed, full card update), or null.
    switch (event.type) {
        case 'message_start': {
            // A new assistant message begins: archive the previous message's
            // answer into the collapsible process log and start fresh, so the
            // main content shows only the FINAL answer (not the run narrative).
            if (event.message?.role === 'assistant') {
                finishOpenReasoning(state);
                if (state.answer.trim()) {
                    // A previous assistant message is already visible in the
                    // answer body. Adding it again as a "过程" entry turns the
                    // expandable panel into a duplicate transcript.
                    state.answer = '';
                    return 'full';
                }
            }
            return null;
        }
        case 'message_update': {
            const ev = event.assistantMessageEvent;
            if (ev?.type === 'text_delta' && ev.delta) {
                state.answer += ev.delta;
                finishOpenReasoning(state);
                if (state.status !== 'tool' && state.status !== 'done' && state.status !== 'error')
                    state.status = 'answering';
                return 'text';
            }
            if (ev?.type === 'thinking_delta' && ev.delta) {
                if (state.status === 'answering' || state.status === 'done' || state.status === 'error') {
                    // late thinking after answer started: ignore in timeline
                    return false;
                }
                const entry = state.reasonings[state.reasonings.length - 1];
                if (!entry || entry.status !== 'running') {
                    state.reasonings.push({
                        title: `思考 ${state.reasonings.length + 1}`,
                        status: 'running',
                        content: '',
                    });
                    state.timeline.push(state.reasonings[state.reasonings.length - 1]);
                }
                const open = state.reasonings[state.reasonings.length - 1];
                if (open.content.length < MAX_REASONING_CHARS * 4) {
                    open.content += ev.delta;
                }
                if (state.status !== 'tool')
                    state.status = 'thinking';
                return 'text';
            }
            return null;
        }
        case 'tool_execution_start': {
            localizeOpenReasoningForTool(state, event.toolName, event.args);
            finishOpenReasoning(state);
            state.tools.push({
                name: event.toolName || 'tool',
                args: event.args,
                toolCallId: event.toolCallId,
                state: 'running',
                detail: '',
            });
            state.timeline.push(state.tools[state.tools.length - 1]);
            state.toolIndex.set(event.toolCallId, state.tools.length - 1);
            state.toolCount++;
            state.status = 'tool';
            return 'full';
        }
        case 'tool_execution_update': {
            const index = state.toolIndex.get(event.toolCallId);
            if (index === undefined)
                return false;
            const partial = event.partialResult;
            if (partial !== undefined && partial !== null) {
                state.tools[index].detail = summarizeValue(partial, MAX_TOOL_RESULT_CHARS);
                return 'full';
            }
            return null;
        }
        case 'tool_execution_end': {
            const index = state.toolIndex.get(event.toolCallId);
            if (index === undefined)
                return false;
            state.tools[index].state = event.isError ? 'error' : 'done';
            if (event.isError) {
                state.tools[index].detail = `错误: ${summarizeValue(event.result, MAX_TOOL_RESULT_CHARS)}`;
            }
            else {
                state.tools[index].detail = summarizeValue(event.result, MAX_TOOL_RESULT_CHARS);
            }
            return 'full';
        }
        case 'turn_end': {
            finishOpenReasoning(state);
            if (state.status === 'tool')
                state.status = 'thinking';
            return 'full';
        }
        case 'message_end': {
            const msg = event.message;
            if (msg?.usage && msg.role === 'assistant') {
                const u = msg.usage;
                // usage.input/cacheRead already include the full prompt history;
                // use the LAST message's values (no summing across turns)
                state.usage = {
                    input: u.input || 0,
                    cacheRead: u.cacheRead || 0,
                    output: u.output || 0,
                };
                state.outputTotal = (state.outputTotal || 0) + (u.output || 0);
                state.cost += u.cost?.total || 0;
            }
            return null;
        }
        case 'error':
            state.errorText = event.error?.message || String(event.error || '出错');
            state.status = 'error';
            return 'full';
    }
    return null;
}
function finishOpenReasoning(state) {
    const entry = state.reasonings[state.reasonings.length - 1];
    if (entry && entry.status === 'running') {
        entry.status = 'completed';
    }
}

function localizeOpenReasoningForTool(state, toolName, args) {
    const entry = state.reasonings[state.reasonings.length - 1];
    if (!entry || entry.status !== 'running')
        return;
    const original = String(entry.content || '').replace(/\s+/g, ' ').trim();
    // The Pi model often emits a long English private deliberation. Hermes'
    // useful UI is an action-oriented timeline, so retain short Chinese plans
    // but replace opaque/internal text with the specific next action.
    if (original && /[\u3400-\u9fff]/.test(original) && original.length <= MAX_REASONING_CHARS)
        return;
    entry.content = reasoningActionForTool(toolName, args);
}

function reasoningActionForTool(toolName, args) {
    const rawName = String(toolName || '').toLowerCase();
    const declaredTool = String(args?.tool || '').toLowerCase();
    const name = `${rawName} ${declaredTool}`;
    if (/whoop.*get_today|get_today.*whoop/.test(name))
        return '查询今天的 WHOOP 恢复、睡眠与活动情况。';
    if (/12306.*get_tickets|get_tickets/.test(name))
        return '查询实时车次，并按当前筛选条件核对结果。';
    if (/12306.*interline|get_interline/.test(name))
        return '查询中转车次方案，并核对衔接信息。';
    if (/read_file|read.*file/.test(name))
        return '读取所需资料，核对当前信息。';
    if (/settings\.json|config/.test(JSON.stringify(args || {})))
        return '读取实时配置，避免依据旧记录作答。';
    if (isShellTool(toolName))
        return `${shellOperationLabel(args)}。`;
    return '准备执行下一步查询。';
}

function renderFooter(state, done) {
    if (state.status === 'error')
        return '已停止';
    if (!done) {
        return `${spinnerFrame()} 生成中`;
    }
    const values = ['已完成'];
    // usage = last assistant message; input+cacheRead = actual prompt/context size.
    // cacheRead tokens are part of the prompt; include them in input/context totals
    const inputTotal = (state.usage?.input || 0) + (state.usage?.cacheRead || 0);
    const outputTotal = state.outputTotal || 0;
    const maxCtx = state.contextWindow || 0;
    values.push(formatDuration((Date.now() - state.startedAt) / 1000));
    values.push(coloredModel(state.model) || 'Unknown');
    values.push(`↑${formatCount(inputTotal)}`);
    values.push(`↓${formatCount(outputTotal)}`);
    if (maxCtx > 0) {
        const pct = Math.round((inputTotal / maxCtx) * 100);
        values.push(`ctx ${formatCount(inputTotal)}/${formatCount(maxCtx)} ${pct}%`);
    }
    return values.filter(Boolean).join(' · ');
}

function renderProcessEntry(entry) {
    return `**${entry.title}**\n${truncate(entry.content || '', 300)}`;
}

function buildTimelinePanel(state) {
    const preview = renderTimelinePreview(state);
    if (preview.entries.length === 0)
        return null;
    const panelElements = [];
    if (preview.folded > 0) {
        panelElements.push({
            tag: 'markdown',
            element_id: 'timeline_folded',
            content: `> 已折叠 ${preview.folded} 条早期思考/工具记录`,
            text_size: 'x-small',
        });
    }
    preview.entries.forEach((item, index) => {
        let content;
        if (item.kind === 'process')
            content = renderProcessEntry(item);
        else if (item.name !== undefined)
            content = renderToolRow(item);
        else
            content = renderReasoningEntry(item);
        panelElements.push({
            tag: 'markdown',
            element_id: `timeline_entry_${index}`,
            content,
            text_size: 'small',
        });
    });
    return {
        tag: 'collapsible_panel',
        element_id: 'timeline',
        expanded: false,
        header: {
            title: {
                tag: 'plain_text',
                content: `思考与工具 · ${state.toolCount} 次工具调用`,
            },
            vertical_align: 'center',
        },
        border: { color: 'grey', corner_radius: '8px' },
        padding: '8px 8px 8px 8px',
        elements: panelElements,
    };
}

export function getTimelineEntries(state) {
    // Older persisted cards do not have the unified timeline array. Keep them
    // readable while all new events retain the order in which they arrived.
    if (Array.isArray(state.timeline))
        return state.timeline;
    return [...state.process, ...state.reasonings, ...state.tools];
}

function compactReasoning(text) {
    return truncate(markdownClean(String(text ?? '').replace(/\s+/g, ' ').trim()), MAX_REASONING_CHARS);
}

function friendlyToolName(name, args) {
    const raw = String(name ?? '').trim();
    let candidate = raw.toLowerCase();
    if (candidate === 'mcp') {
        const server = typeof args?.server === 'string' ? args.server.trim().toLowerCase() : '';
        const target = typeof args?.tool === 'string' && args.tool.trim()
            ? args.tool.trim()
            : typeof args?.name === 'string' && args.name.trim()
                ? args.name.trim()
                : '';
        const serverLabel = FRIENDLY_SERVER_LABELS[server] || server;
        if (target) {
            const targetLabel = friendlyToolName(target, {});
            return server ? `${serverLabel} · ${targetLabel}` : targetLabel;
        }
        if (server)
            return `${serverLabel} MCP`;
        return '调用 MCP';
    }
    candidate = candidate.replace(/^mcp__/, '');
    const leaf = candidate.split('__').pop() || candidate;
    return FRIENDLY_TOOL_LABELS[candidate] || FRIENDLY_TOOL_LABELS[leaf] || toolDisplayName(name, args);
}

function toolDisplayName(name, args) {
    const raw = String(name ?? '').trim();
    const normalized = raw.toLowerCase();
    // MCP names are intentionally technical: they identify the exact action
    // and, together with its parameters, are useful audit information.
    if (normalized === 'mcp' && typeof args?.tool === 'string' && args.tool.trim())
        return `mcp__${args.tool.trim().replace(/^mcp__/i, '')}`.slice(0, 96);
    if (normalized === 'mcp' || normalized.startsWith('mcp__'))
        return raw.slice(0, 96);
    if (/^(bash|shell|exec|command|terminal)$/.test(normalized))
        return '系统操作';
    return raw ? raw.slice(0, 96) : '工具';
}

function isSemanticMcpTool(name) {
    const normalized = String(name ?? '').trim().toLowerCase();
    return normalized === 'mcp' || normalized.startsWith('mcp__');
}

function semanticMcpArguments(args, genericMcp) {
    if (!genericMcp || !args || typeof args !== 'object')
        return args ?? {};
    if (args.args && typeof args.args === 'object')
        return args.args;
    const { tool, ...rest } = args;
    return rest;
}

function semanticToolParameters(args, genericMcp = false) {
    try {
        const raw = JSON.stringify(redactValue(semanticMcpArguments(args, genericMcp)));
        return `参数: ${truncate(raw, 480)}`;
    }
    catch {
        return '参数: （无法显示）';
    }
}

function hasSemanticParameters(args, genericMcp = false) {
    const parameters = semanticMcpArguments(args, genericMcp);
    return Boolean(parameters && typeof parameters === 'object' && Object.keys(parameters).length > 0);
}

function semanticToolResult(detail) {
    const safe = String(detail ?? '')
        .replace(/\b(token|secret|password|api[-_]?key|authorization)\s*[:=]\s*\S+/gi, '$1=[REDACTED]')
        .replace(/\s+/g, ' ')
        .trim();
    return safe ? `结果: ${truncate(safe, 280)}` : '结果: 已完成';
}

function directToolDetail(name, args, result) {
    const normalized = String(name || '').toLowerCase();
    if (/whoop.*get_today|get_today.*whoop/.test(normalized))
        return '结果: 已读取今日恢复、睡眠与活动数据';
    // File-read results can contain credentials or private material; disclose
    // only the safe request metadata, never the content.
    if (/read_file|read.*file/.test(normalized))
        return safeToolParameters(args);
    const safeArgs = safeToolParameters(args);
    const hasArgs = safeArgs !== '参数: {}';
    if (hasArgs)
        return safeArgs;
    return result ? semanticToolResult(result) : safeArgs;
}

function shellOperationLabel(args, detail = '') {
    const command = String(args?.command ?? args?.cmd ?? args?.script ?? '').toLowerCase();
    const probesModelService = /opencode|deepseek|gpt-5|models/.test(command) && /curl|fetch|http/.test(command);
    if (/icloud[-_]calendar|icloud_calendar|icloud-calendar-mcp/.test(command))
        return '检查 iCloud 日历 MCP';
    if (/timedatectl|tz=asia\/shanghai.*\bdate\b/.test(command))
        return '读取北京时间';
    if (/\.mcp\.json|docker-compose\.yml|config\.json/.test(command))
        return '读取服务配置';
    const readsPiConfig = /settings\.json|models(?:-store)?\.json|pi-channels/.test(command);
    if (readsPiConfig && probesModelService)
        return '读取 Pi 配置并探测模型服务';
    if (readsPiConfig)
        return '读取 Pi 实时配置';
    if (probesModelService)
        return '查询模型服务可用性';
    if (/systemctl|service\s/.test(command))
        return '检查服务运行状态';
    if (/12306|leftticket|interline/.test(command))
        return '查询 12306 车票信息';
    if (/npm\s+test|node\s+--check|pytest|vitest|jest/.test(command))
        return '运行回归检查';
    if (/\b(?:cat|sed|head|tail|less|grep|rg)\b/.test(command))
        return /\bssh\b/.test(command) ? '读取远程资料' : '读取资料';
    return '执行系统检查';
}

function shellOperationOutcome(detail, state) {
    if (state === 'error' || state === 'failed')
        return '未完成';
    if (state !== 'done' && state !== 'completed' && state !== 'success')
        return '进行中';
    const output = String(detail ?? '').toLowerCase();
    if (/\b403\b/.test(output))
        return '模型服务返回 403';
    if (/\b401\b/.test(output))
        return '模型服务认证失败';
    if (/timeout|timed out/.test(output))
        return '请求超时';
    if (/\bactive\b/.test(output))
        return '服务正常';
    return '已完成';
}

function isShellTool(name) {
    return /^(bash|shell|exec|command|terminal)$/i.test(String(name ?? '').trim());
}

function isAuditableTool(name) {
    return String(name ?? '').trim().length > 0 && !isShellTool(name);
}

function safeToolParameters(args) {
    if (!args || typeof args !== 'object')
        return '参数: {}';
    const safe = {};
    const allowed = new Set(['path', 'filePath', 'file_path', 'url', 'query', 'tool', 'args', 'date', 'fromStation', 'toStation', 'trainFilterFlags']);
    for (const [key, value] of Object.entries(args)) {
        if (allowed.has(key))
            safe[key] = redactValue(value);
    }
    try {
        return `参数: ${truncate(JSON.stringify(safe), 480)}`;
    }
    catch {
        return '参数: （无法显示）';
    }
}

function shellOperationSummary(tool) {
    return `${shellOperationLabel(tool.args, tool.detail)}：${shellOperationOutcome(tool.detail, String(tool.state || 'running').toLowerCase())}`;
}

function toolSummary(tool) {
    const state = String(tool.state || 'running').toLowerCase();
    if (isShellTool(tool.name))
        return shellOperationSummary(tool);
    const name = toolDisplayName(tool.name);
    if (state === 'error' || state === 'failed')
        return `${name}未完成`;
    if (state === 'done' || state === 'completed' || state === 'success')
        return `${name}已完成`;
    return `${name}进行中`;
}

function compactTimelineEntry(entry) {
    if (entry?.name !== undefined) {
        const genericMcp = String(entry.name ?? '').trim().toLowerCase() === 'mcp';
        const displayName = friendlyToolName(entry.name, entry.args);
        const semantic = isSemanticMcpTool(entry.name);
        const terminal = ['done', 'completed', 'success', 'error', 'failed'].includes(String(entry.state || '').toLowerCase());
        const failed = ['error', 'failed'].includes(String(entry.state || '').toLowerCase());
        const detail = semantic
            ? failed
                ? semanticToolResult(entry.detail)
                : terminal
                    ? ''
                    : hasSemanticParameters(entry.args, genericMcp)
                        ? semanticToolParameters(entry.args, genericMcp)
                        : genericMcp && entry.args?.tool
                            ? semanticToolParameters(entry.args, genericMcp)
                            : ''
            : isShellTool(entry.name)
                ? toolSummary(entry)
                : directToolDetail(entry.name, entry.args, entry.detail);
        const shellSummary = isShellTool(entry.name) ? shellOperationSummary(entry) : null;
        return {
            kind: 'tool',
            isShellSummary: Boolean(shellSummary),
            name: shellSummary ?? displayName,
            displayName: shellSummary ?? displayName,
            state: entry.state,
            // Shell commands are intentionally represented by a single safe
            // sentence. Do not fall back to their raw args in renderToolRow.
            detail: shellSummary ? '' : detail,
            content: semantic || isAuditableTool(entry.name)
                ? `${displayName} · ${['done', 'completed', 'success'].includes(String(entry.state || '').toLowerCase()) ? '已完成' : String(entry.state || 'running')}\n${detail}`
                : shellSummary ?? toolSummary(entry),
        };
    }
    return {
        ...entry,
        kind: entry?.kind || 'reasoning',
        content: compactReasoning(entry?.content),
    };
}

export function renderTimelinePreview(state) {
    // Do not surface archived assistant answer bodies: they duplicate the main
    // response and commonly contain raw command/output transcripts.
    const all = getTimelineEntries(state).filter((entry) => entry?.kind !== 'process');
    const selected = all.slice(-MAX_TIMELINE_ITEMS).map(compactTimelineEntry);
    return { entries: selected, folded: Math.max(0, all.length - selected.length) };
}

export function buildCard(state, done = false) {
    const elements = [];
    const primaryText = state.answer
        ? markdownClean(state.answer)
        : done
            ? '（本轮无文本输出）'
            : state.status === 'tool'
                ? `${spinnerFrame()} 正在执行工具…`
                : `${spinnerFrame()} 正在思考…`;
    if (state.status === 'error') {
        elements.push({
            tag: 'markdown',
            element_id: 'main_content',
            content: truncate(markdownClean(state.errorText || '出错了'), 2000),
        });
    }
    else {
        chunkMarkdown(primaryText).forEach((chunk, index) => {
            elements.push({
                tag: 'markdown',
                element_id: index === 0 ? 'main_content' : `main_content_${index}`,
                content: chunk,
            });
        });
    }
    const timeline = buildTimelinePanel(state);
    if (timeline)
        elements.push(timeline);
    elements.push({ tag: 'hr', element_id: 'main_divider' });
    const footer = renderFooter(state, done);
    elements.push({
        tag: 'markdown',
        element_id: 'footer',
        content: footer,
        text_size: 'x-small',
    });
    const subtitle = statusLabel(state);
    const card = {
        schema: '2.0',
        config: {
            update_multi: true,
            streaming_mode: true,
            streaming_config: {
                print_frequency_ms: { default: 10 },
                print_step: { default: 1 },
                print_strategy: 'fast',
            },
            summary: { content: done ? '已完成' : subtitle },
        },
        header: {
            template: statusTemplate(state),
            title: { tag: 'plain_text', content: 'π pi' },
            subtitle: { tag: 'plain_text', content: subtitle },
        },
        body: { elements },
    };
    return shrinkToBytes(card);
}

function countMarkdownTables(text) {
    const lines = String(text ?? '').split('\n');
    let count = 0;
    for (let index = 0; index + 1 < lines.length; index++) {
        if (/\|/.test(lines[index]) && /^\s*\|?\s*:?-{3,}/.test(lines[index + 1]))
            count++;
    }
    return count;
}

function countCardNodes(value) {
    if (Array.isArray(value))
        return value.reduce((total, item) => ({ elements: total.elements + countCardNodes(item).elements, tables: total.tables + countCardNodes(item).tables }), { elements: 0, tables: 0 });
    if (!value || typeof value !== 'object')
        return { elements: 0, tables: 0 };
    let elements = typeof value.tag === 'string' ? 1 : 0;
    let tables = value.tag === 'table' ? 1 : value.tag === 'markdown' ? countMarkdownTables(value.content) : 0;
    for (const nested of Object.values(value)) {
        const counts = countCardNodes(nested);
        elements += counts.elements;
        tables += counts.tables;
    }
    return { elements, tables };
}

export function inspectCardLimits(card) {
    const jsonBytes = Buffer.byteLength(JSON.stringify(card), 'utf8');
    const counts = countCardNodes(card);
    const violations = [];
    if (jsonBytes > MAX_CARD_BYTES)
        violations.push('json_bytes');
    if (counts.elements > MAX_CARD_ELEMENTS)
        violations.push('elements');
    if (counts.tables > MAX_CARD_TABLES)
        violations.push('tables');
    return { jsonBytes, elementCount: counts.elements, tableCount: counts.tables, violations };
}

function truncateUtf8(text, maxBytes) {
    let out = '';
    for (const char of String(text ?? '')) {
        if (Buffer.byteLength(out + char, 'utf8') > maxBytes)
            return `${out}…`;
        out += char;
    }
    return out;
}

function removeExcessTables(card) {
    let remaining = MAX_CARD_TABLES;
    const visit = (value) => {
        if (Array.isArray(value))
            value.forEach(visit);
        else if (value && typeof value === 'object') {
            if (value.tag === 'markdown' && typeof value.content === 'string') {
                const lines = value.content.split('\n');
                for (let index = 0; index + 1 < lines.length; index++) {
                    if (/\|/.test(lines[index]) && /^\s*\|?\s*:?-{3,}/.test(lines[index + 1])) {
                        remaining--;
                        if (remaining < 0) {
                            lines[index] = lines[index].replaceAll('|', '\\|');
                            lines[index + 1] = lines[index + 1].replaceAll('|', '\\|');
                        }
                    }
                }
                value.content = lines.join('\n');
            }
            Object.values(value).forEach(visit);
        }
    };
    visit(card);
}

function shrinkToBytes(card) {
    const body = card.body.elements;
    removeExcessTables(card);
    let inspection = inspectCardLimits(card);
    if (!inspection.violations.length)
        return card;
    // Keep the beginning of the answer and make its truncation explicit. This
    // is preferable to a rejected update or a card that freezes mid-answer.
    for (let index = body.length - 1; index >= 0; index--) {
        if (/^main_content_\d+$/.test(body[index]?.element_id || ''))
            body.splice(index, 1);
    }
    if (typeof body[0]?.content === 'string')
        body[0].content = `${truncateUtf8(body[0].content, 11_000)}\n> 内容过长，已折叠`;
    inspection = inspectCardLimits(card);
    if (inspection.violations.length) {
        const panelIndex = body.findIndex((element) => element.tag === 'collapsible_panel');
        if (panelIndex !== -1)
            body.splice(panelIndex, 1);
    }
    while (inspectCardLimits(card).violations.includes('elements') && body.length > 2) {
        body.splice(1, 1);
    }
    return card;
}

export function finalizeCardState(state, result) {
    state.status = result.ok ? 'done' : 'error';
    if (!state.answer && result.ok) {
        state.answer = result.response || '';
    }
    if (!result.ok && !state.errorText) {
        state.errorText = result.error || '任务失败';
    }
}
