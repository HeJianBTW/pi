import type {
  Comment,
  ExecFn,
  Issue,
  IssueCreateInput,
  IssueListFilter,
  IssueUpdateInput,
  MulticaAdapterConfig,
  Project,
  TeamworkProvider,
} from '../types.js';

export async function initMulticaProvider(
  config: MulticaAdapterConfig,
  exec: ExecFn,
): Promise<MulticaAdapter> {
  const binary = config.binary?.trim() || 'multica';

  if (config.token) {
    try {
      await exec(binary, ['login', '--token', config.token]);
    } catch {
      // Login may already be done
    }
  }

  try {
    await exec(binary, ['daemon', 'start']);
  } catch {
    // Daemon may already be running
  }

  return new MulticaAdapter(config, exec);
}

export class MulticaAdapter implements TeamworkProvider {
  readonly name = 'multica';
  private readonly binary: string;
  private readonly workspaceArgs: string[];

  constructor(
    config: MulticaAdapterConfig,
    private readonly exec: ExecFn,
  ) {
    this.binary = config.binary?.trim() || 'multica';
    this.workspaceArgs = config.workspace?.trim()
      ? ['--workspace-id', config.workspace.trim()]
      : [];
  }

  async listIssues(filter?: IssueListFilter): Promise<Issue[]> {
    const args = ['issue', 'list', '--output', 'json', ...this.workspaceArgs];
    if (filter?.status) args.push('--status', filter.status);
    if (filter?.assignee) args.push('--assignee', filter.assignee);
    if (filter?.project) args.push('--project', filter.project);
    if (filter?.limit) args.push('--limit', String(filter.limit));
    const result = await this.run(args);
    const data = parseJson(result);
    if (!Array.isArray(data)) return [];
    return data.map(mapIssue);
  }

  async getIssue(id: string): Promise<Issue | undefined> {
    const result = await this.run(['issue', 'get', id, '--output', 'json', ...this.workspaceArgs]);
    const data = parseJson(result);
    if (!data || typeof data !== 'object') return undefined;
    return mapIssue(data);
  }

  async createIssue(input: IssueCreateInput): Promise<Issue> {
    const args = ['issue', 'create', '--title', input.title, ...this.workspaceArgs];
    if (input.description) args.push('--description', input.description);
    if (input.priority) args.push('--priority', input.priority);
    if (input.assignee) args.push('--assignee', input.assignee);
    if (input.project) args.push('--project', input.project);
    const result = await this.run(args);
    const data = parseJson(result);
    if (data && typeof data === 'object') return mapIssue(data);
    return { id: 'unknown', title: input.title, status: 'todo' };
  }

  async updateIssue(id: string, input: IssueUpdateInput): Promise<Issue | undefined> {
    if (input.status) {
      await this.run(['issue', 'status', id, input.status, ...this.workspaceArgs]);
    }
    const updateArgs: string[] = [];
    if (input.title) updateArgs.push('--title', input.title);
    if (input.description) updateArgs.push('--description', input.description);
    if (input.priority) updateArgs.push('--priority', input.priority);
    if (input.assignee) updateArgs.push('--assignee', input.assignee);
    if (updateArgs.length > 0) {
      await this.run(['issue', 'update', id, ...updateArgs, ...this.workspaceArgs]);
    }
    return this.getIssue(id);
  }

  async addComment(issueId: string, content: string, parentId?: string): Promise<Comment> {
    const args = ['issue', 'comment', 'add', issueId, '--content', content, ...this.workspaceArgs];
    if (parentId) args.push('--parent', parentId);
    const result = await this.run(args);
    const data = parseJson(result);
    if (data && typeof data === 'object') {
      return {
        id: String((data as Record<string, unknown>).id ?? 'unknown'),
        issueId,
        content,
        author: String((data as Record<string, unknown>).author ?? ''),
        createdAt: String((data as Record<string, unknown>).created_at ?? ''),
        ...(parentId ? { parentId } : {}),
      };
    }
    return { id: 'unknown', issueId, content };
  }

  async listComments(issueId: string): Promise<Comment[]> {
    const result = await this.run([
      'issue', 'comment', 'list', issueId, '--output', 'json', ...this.workspaceArgs,
    ]);
    const data = parseJson(result);
    if (!Array.isArray(data)) return [];
    return data.map((item) => ({
      id: String(item.id ?? ''),
      issueId,
      content: String(item.content ?? item.body ?? ''),
      author: String(item.author ?? item.user ?? ''),
      createdAt: String(item.created_at ?? ''),
      ...(item.parent_id ? { parentId: String(item.parent_id) } : {}),
    }));
  }

  async listProjects(): Promise<Project[]> {
    const result = await this.run(['project', 'list', '--output', 'json', ...this.workspaceArgs]);
    const data = parseJson(result);
    if (!Array.isArray(data)) return [];
    return data.map((item) => ({
      id: String(item.id ?? ''),
      title: String(item.title ?? item.name ?? ''),
      ...(item.description ? { description: String(item.description) } : {}),
      ...(item.status ? { status: String(item.status) } : {}),
      ...(item.lead ? { lead: String(item.lead) } : {}),
    }));
  }

  async status(): Promise<Record<string, unknown>> {
    const result = await this.run(['daemon', 'status', '--output', 'json']);
    const data = parseJson(result);
    if (data && typeof data === 'object' && !Array.isArray(data)) {
      return data as Record<string, unknown>;
    }
    return { raw: result };
  }

  private async run(args: string[]): Promise<string> {
    const { stdout, stderr, code } = await this.exec(this.binary, args);
    if (code !== 0) {
      const message = stderr.trim() || stdout.trim() || `Exit code ${code}`;
      throw new Error(`multica ${args[0]} failed: ${message}`);
    }
    return stdout;
  }
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text.trim());
  } catch {
    return undefined;
  }
}

function mapIssue(raw: unknown): Issue {
  const item = raw as Record<string, unknown>;
  return {
    id: String(item.id ?? ''),
    title: String(item.title ?? ''),
    status: String(item.status ?? 'unknown'),
    ...(item.description ? { description: String(item.description) } : {}),
    ...(item.priority ? { priority: String(item.priority) } : {}),
    ...(item.assignee ? { assignee: String(item.assignee) } : {}),
    ...(item.project ? { project: String(item.project) } : {}),
    ...(item.created_at ? { createdAt: String(item.created_at) } : {}),
    ...(item.updated_at ? { updatedAt: String(item.updated_at) } : {}),
    ...(item.metadata && typeof item.metadata === 'object'
      ? { metadata: item.metadata as Record<string, unknown> }
      : {}),
  };
}
