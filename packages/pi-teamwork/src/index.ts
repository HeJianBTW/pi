import { loadPiSettings, resolveAgentDir } from '@amaster.ai/pi-shared/settings';
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { Type } from 'typebox';
import { initMulticaProvider } from './adapters/multica.js';
import type { ExecFn, TeamworkConfig, TeamworkProvider } from './types.js';

const SETTINGS_KEY = 'pi-teamwork';
const STATUS_KEY = 'pi-teamwork';

export default function piTeamworkExtension(pi: ExtensionAPI): void {
  let provider: TeamworkProvider | undefined;

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
      provider = await initMulticaProvider(config.multica ?? {}, exec);
      ctx.ui.setStatus(STATUS_KEY, 'teamwork: multica');
    } else {
      ctx.ui.setStatus(STATUS_KEY, `teamwork: unknown provider "${providerName}"`);
    }
  });

  pi.on('session_shutdown', async () => {
    provider = undefined;
  });

  pi.registerCommand('teamwork-status', {
    description: 'Show teamwork provider status.',
    handler: async (_args, ctx) => {
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

  pi.registerTool({
    name: 'issue_list',
    label: 'Teamwork',
    description:
      'List issues from the project management system. Supports filtering by status, assignee, and project.',
    promptSnippet: 'List issues from the team project tracker with optional filters.',
    parameters: Type.Object({
      status: Type.Optional(
        Type.String({ description: 'Filter by status (e.g. todo, in_progress, done, blocked).' }),
      ),
      assignee: Type.Optional(Type.String({ description: 'Filter by assignee name.' })),
      project: Type.Optional(Type.String({ description: 'Filter by project ID.' })),
      limit: Type.Optional(Type.Number({ description: 'Max number of results.' })),
    }),
    async execute(_toolCallId, params) {
      if (!provider) return textResult('Teamwork provider is not initialized.');
      try {
        const issues = await provider.listIssues(params);
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
    description: 'Get detailed information about a specific issue.',
    parameters: Type.Object({
      id: Type.String({ description: 'The issue ID.' }),
    }),
    async execute(_toolCallId, params) {
      if (!provider) return textResult('Teamwork provider is not initialized.');
      try {
        const issue = await provider.getIssue(params.id);
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
    description: 'Create a new issue in the project management system.',
    promptSnippet: 'Create issues in the team project tracker.',
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
      if (!provider) return textResult('Teamwork provider is not initialized.');
      try {
        const issue = await provider.createIssue(params);
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
      'Update an existing issue. Can change title, description, status, priority, or assignee.',
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
      if (!provider) return textResult('Teamwork provider is not initialized.');
      const { id, ...input } = params;
      try {
        const issue = await provider.updateIssue(id, input);
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
    description: 'Add a comment to an issue. Use for progress updates, questions, or blockers.',
    parameters: Type.Object({
      issueId: Type.String({ description: 'The issue ID to comment on.' }),
      content: Type.String({ description: 'Comment content.' }),
      parentId: Type.Optional(
        Type.String({ description: 'Parent comment ID for threaded replies.' }),
      ),
    }),
    async execute(_toolCallId, params) {
      if (!provider) return textResult('Teamwork provider is not initialized.');
      try {
        const comment = await provider.addComment(params.issueId, params.content, params.parentId);
        return textResult(JSON.stringify(comment, null, 2));
      } catch (error) {
        return textResult(`Error: ${error instanceof Error ? error.message : String(error)}`);
      }
    },
  });

  pi.registerTool({
    name: 'project_list',
    label: 'Teamwork',
    description: 'List all projects in the workspace.',
    parameters: Type.Object({}),
    async execute() {
      if (!provider) return textResult('Teamwork provider is not initialized.');
      try {
        const projects = await provider.listProjects();
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
      'Check the status of the teamwork provider (daemon status, connected agents, etc.).',
    parameters: Type.Object({}),
    async execute() {
      if (!provider) return textResult('Teamwork provider is not initialized.');
      try {
        const s = await provider.status();
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
      agentDir: resolveAgentDir(),
    });
    return Object.keys(config).length > 0 ? (config as TeamworkConfig) : {};
  } catch {
    return {};
  }
}
