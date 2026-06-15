import { loadPiSettings } from '@amaster.ai/pi-shared/settings';
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { Type } from 'typebox';
import { initMulticaProvider } from './adapters/multica.js';
import type { ExecFn, TeamworkConfig, TeamworkProvider } from './types.js';

const SETTINGS_KEY = 'pi-teamwork';
const STATUS_KEY = 'pi-teamwork';

const TEAMWORK_GUIDANCE = [
  '<teamwork-guidance>',
  'You are working in a shared project tracker (teamwork) where humans and other agents collaborate. Use the issue_* and project_* tools to keep that shared space in sync.',
  '',
  'Before starting non-trivial work, check whether a relevant issue already exists (issue_list / issue_get) — to avoid duplicating work another collaborator has picked up.',
  '',
  'When you reach meaningful progress, hit a blocker, or need input from a collaborator, leave a comment on the relevant issue (issue_comment). Comments are how humans and other agents observe what you are doing.',
  '',
  'When you finish work that an issue describes, update its status (issue_update). An issue left in an outdated state misleads other collaborators.',
  '',
  'The tracker is for cross-collaborator coordination, not for tracking your own session-local TODOs. Do not file an issue just to remind yourself of something within the current conversation.',
  '</teamwork-guidance>',
].join('\n');

export default function piTeamworkExtension(pi: ExtensionAPI): void {
  let provider: TeamworkProvider | undefined;
  let readyPromise: Promise<void> | undefined;

  const exec: ExecFn = async (command, args) => {
    const result = await pi.exec(command, args);
    return { stdout: result.stdout, stderr: result.stderr, code: result.code };
  };

  pi.on('session_start', async (_event, ctx) => {
    const config = loadConfig(ctx.cwd);
    if (config.enabled === false) {
      ctx.ui.setStatus(STATUS_KEY, 'teamwork: disabled');
      return;
    }

    const providerName = config.provider ?? 'multica';
    if (providerName === 'multica') {
      readyPromise = (async () => {
        const { adapter, installResult } = await initMulticaProvider(config.multica ?? {}, exec);
        provider = adapter;

        if (!installResult.installed) {
          ctx.ui.notify(
            `multica CLI could not be installed: ${installResult.error ?? 'unknown error'}. Run "multica setup" manually.`,
            'warning',
          );
          ctx.ui.setStatus(STATUS_KEY, 'teamwork: multica (not installed)');
          return;
        }

        if (!installResult.alreadyPresent) {
          ctx.ui.notify('multica CLI was auto-installed successfully.', 'info');
        }

        if (!config.multica?.token && !config.multica?.serverUrl) {
          ctx.ui.notify(
            'No multica token or serverUrl configured. Run "multica setup" to authenticate.',
            'warning',
          );
        }

        ctx.ui.setStatus(STATUS_KEY, 'teamwork: multica');
      })();
    } else {
      ctx.ui.setStatus(STATUS_KEY, `teamwork: unknown provider "${providerName}"`);
    }
  });

  pi.on('session_shutdown', async () => {
    provider = undefined;
    readyPromise = undefined;
  });

  pi.on('before_agent_start', async (event) => {
    if (!provider) return;
    return {
      systemPrompt: event.systemPrompt
        ? `${event.systemPrompt}\n\n${TEAMWORK_GUIDANCE}`
        : TEAMWORK_GUIDANCE,
    };
  });

  pi.registerCommand('teamwork-status', {
    description: 'Show teamwork provider status.',
    handler: async (_args, ctx) => {
      if (readyPromise) await readyPromise;
      if (!provider) {
        ctx.ui.notify('Teamwork provider is not initialized.', 'warning');
        return;
      }
      try {
        const s = await provider.status();
        ctx.ui.notify(JSON.stringify(s, null, 2), 'info');
      } catch (error) {
        ctx.ui.notify(`Error: ${error instanceof Error ? error.message : String(error)}`, 'error');
      }
    },
  });

  // --- LLM-callable tools ---

  async function ensureReady(): Promise<string | undefined> {
    if (readyPromise) await readyPromise;
    if (!provider) return 'Teamwork provider is not initialized.';
    return undefined;
  }

  pi.registerTool({
    name: 'issue_list',
    label: 'Teamwork',
    description:
      'List issues from a shared project tracker. Issues are work items that humans or other agents collaborate on. Supports filtering by status, assignee, and project.',
    promptSnippet: 'List issues from a shared project tracker where humans and agents collaborate.',
    parameters: Type.Object({
      status: Type.Optional(
        Type.String({ description: 'Filter by status (e.g. todo, in_progress, done, blocked).' }),
      ),
      assignee: Type.Optional(Type.String({ description: 'Filter by assignee name.' })),
      project: Type.Optional(Type.String({ description: 'Filter by project ID.' })),
      limit: Type.Optional(Type.Number({ description: 'Max number of results.' })),
    }),
    async execute(_toolCallId, params) {
      const err = await ensureReady();
      if (err) return textResult(err);
      try {
        const issues = await provider!.listIssues(params);
        if (issues.length === 0) return textResult('No issues found.');
        return textResult(JSON.stringify(issues, null, 2));
      } catch (error) {
        return textResult(`Error: ${error instanceof Error ? error.message : String(error)}`);
      }
    },
  });

  pi.registerTool({
    name: 'issue_get',
    label: 'Teamwork',
    description:
      'Get detailed information about a specific issue (a work item in the shared project tracker).',
    parameters: Type.Object({
      id: Type.String({ description: 'The issue ID.' }),
    }),
    async execute(_toolCallId, params) {
      const err = await ensureReady();
      if (err) return textResult(err);
      try {
        const issue = await provider!.getIssue(params.id);
        if (!issue) return textResult(`Issue not found: ${params.id}`);
        return textResult(JSON.stringify(issue, null, 2));
      } catch (error) {
        return textResult(`Error: ${error instanceof Error ? error.message : String(error)}`);
      }
    },
  });

  pi.registerTool({
    name: 'issue_create',
    label: 'Teamwork',
    description:
      'Create a new issue (a work item / ticket) in the shared project tracker. Use this to file work for humans or other agents to pick up.',
    promptSnippet:
      'Create issues / tickets in a shared project tracker for humans or agents to collaborate on.',
    parameters: Type.Object({
      title: Type.String({ description: 'Issue title.' }),
      description: Type.Optional(Type.String({ description: 'Issue description.' })),
      priority: Type.Optional(
        Type.String({ description: 'Priority (e.g. low, medium, high, urgent).' }),
      ),
      assignee: Type.Optional(Type.String({ description: 'Assignee name.' })),
      project: Type.Optional(Type.String({ description: 'Project ID to associate with.' })),
    }),
    async execute(_toolCallId, params) {
      const err = await ensureReady();
      if (err) return textResult(err);
      try {
        const issue = await provider!.createIssue(params);
        return textResult(JSON.stringify(issue, null, 2));
      } catch (error) {
        return textResult(`Error: ${error instanceof Error ? error.message : String(error)}`);
      }
    },
  });

  pi.registerTool({
    name: 'issue_update',
    label: 'Teamwork',
    description:
      'Update an existing issue in the shared project tracker. Can change title, description, status, priority, or assignee.',
    parameters: Type.Object({
      id: Type.String({ description: 'The issue ID to update.' }),
      title: Type.Optional(Type.String({ description: 'New title.' })),
      description: Type.Optional(Type.String({ description: 'New description.' })),
      status: Type.Optional(
        Type.String({
          description: 'New status (e.g. todo, in_progress, in_review, done, blocked, cancelled).',
        }),
      ),
      priority: Type.Optional(Type.String({ description: 'New priority.' })),
      assignee: Type.Optional(Type.String({ description: 'New assignee name.' })),
    }),
    async execute(_toolCallId, params) {
      const err = await ensureReady();
      if (err) return textResult(err);
      const { id, ...input } = params;
      try {
        const issue = await provider!.updateIssue(id, input);
        if (!issue) return textResult(`Issue not found: ${id}`);
        return textResult(JSON.stringify(issue, null, 2));
      } catch (error) {
        return textResult(`Error: ${error instanceof Error ? error.message : String(error)}`);
      }
    },
  });

  pi.registerTool({
    name: 'issue_comment',
    label: 'Teamwork',
    description:
      'Add a comment to an issue in the shared project tracker. Use for progress updates, questions, or blockers visible to other collaborators (humans or agents).',
    parameters: Type.Object({
      issueId: Type.String({ description: 'The issue ID to comment on.' }),
      content: Type.String({ description: 'Comment content.' }),
      parentId: Type.Optional(
        Type.String({ description: 'Parent comment ID for threaded replies.' }),
      ),
    }),
    async execute(_toolCallId, params) {
      const err = await ensureReady();
      if (err) return textResult(err);
      try {
        const comment = await provider!.addComment(params.issueId, params.content, params.parentId);
        return textResult(JSON.stringify(comment, null, 2));
      } catch (error) {
        return textResult(`Error: ${error instanceof Error ? error.message : String(error)}`);
      }
    },
  });

  pi.registerTool({
    name: 'project_list',
    label: 'Teamwork',
    description: 'List all projects in the shared collaboration workspace.',
    parameters: Type.Object({}),
    async execute() {
      const err = await ensureReady();
      if (err) return textResult(err);
      try {
        const projects = await provider!.listProjects();
        if (projects.length === 0) return textResult('No projects found.');
        return textResult(JSON.stringify(projects, null, 2));
      } catch (error) {
        return textResult(`Error: ${error instanceof Error ? error.message : String(error)}`);
      }
    },
  });

  pi.registerTool({
    name: 'teamwork_status',
    label: 'Teamwork',
    description:
      'Check the status of the teamwork collaboration provider (daemon status, connected agents, etc.).',
    parameters: Type.Object({}),
    async execute() {
      const err = await ensureReady();
      if (err) return textResult(err);
      try {
        const s = await provider!.status();
        return textResult(JSON.stringify(s, null, 2));
      } catch (error) {
        return textResult(`Error: ${error instanceof Error ? error.message : String(error)}`);
      }
    },
  });
}

function textResult(text: string) {
  return { content: [{ type: 'text' as const, text }], details: undefined };
}

function loadConfig(cwd: string): TeamworkConfig {
  try {
    const config = loadPiSettings<Partial<TeamworkConfig>>(SETTINGS_KEY, {
      cwd,
    });
    return Object.keys(config).length > 0 ? (config as TeamworkConfig) : {};
  } catch {
    return {};
  }
}
