export type Issue = {
  id: string;
  title: string;
  description?: string;
  status: string;
  priority?: string;
  assignee?: string;
  project?: string;
  createdAt?: string;
  updatedAt?: string;
  metadata?: Record<string, unknown>;
};

export type IssueCreateInput = {
  title: string;
  description?: string;
  priority?: string;
  assignee?: string;
  project?: string;
};

export type IssueUpdateInput = {
  title?: string;
  description?: string;
  status?: string;
  priority?: string;
  assignee?: string;
};

export type IssueListFilter = {
  status?: string;
  assignee?: string;
  project?: string;
  limit?: number;
};

export type Comment = {
  id: string;
  issueId: string;
  content: string;
  author?: string;
  createdAt?: string;
  parentId?: string;
};

export type Project = {
  id: string;
  title: string;
  description?: string;
  status?: string;
  lead?: string;
};

export interface TeamworkProvider {
  name: string;
  listIssues(filter?: IssueListFilter): Promise<Issue[]>;
  getIssue(id: string): Promise<Issue | undefined>;
  createIssue(input: IssueCreateInput): Promise<Issue>;
  updateIssue(id: string, input: IssueUpdateInput): Promise<Issue | undefined>;
  addComment(issueId: string, content: string, parentId?: string): Promise<Comment>;
  listComments(issueId: string): Promise<Comment[]>;
  listProjects(): Promise<Project[]>;
  status(): Promise<Record<string, unknown>>;
}

export type ExecFn = (
  command: string,
  args: string[],
) => Promise<{ stdout: string; stderr: string; code: number }>;

export type MulticaAdapterConfig = {
  binary?: string;
  workspace?: string;
  token?: string;
  autoInstall?: boolean;
  serverUrl?: string;
};

export type TeamworkConfig = {
  enabled?: boolean;
  provider?: string;
  multica?: MulticaAdapterConfig;
};
