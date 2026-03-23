export type ToolMode = 'auto' | 'safe' | 'plan';

export interface UserSettings {
  // ── Universal ──
  defaultTool: string;
  mode: ToolMode;          // auto=最高权限, safe=需确认, plan=只读
  model: string;           // --model
  sessionIds: Record<string, string>;
  systemPrompt: string;    // --append-system-prompt (Claude)

  // ── Claude Code ──
  effort: string;          // --effort low|medium|high|max
  maxTurns: number;        // --max-turns
  maxBudget: number;       // --max-budget-usd, 0=unlimited
  allowedTools: string;    // --allowedTools "Bash,Read,Edit"
  disallowedTools: string; // --disallowedTools
  verbose: boolean;        // --verbose

  // ── Codex ──
  sandbox: string;         // --sandbox read-only|workspace-write|danger-full-access
  search: boolean;         // --search (web search)

  // ── Working directory ──
  workDir: string;         // override per-user working directory
}

export const DEFAULT_SETTINGS: UserSettings = {
  defaultTool: '',
  mode: 'auto',
  model: '',
  sessionIds: {},
  systemPrompt: '',
  effort: 'high',
  maxTurns: 30,
  maxBudget: 0,
  allowedTools: '',
  disallowedTools: '',
  verbose: false,
  sandbox: '',
  search: false,
  workDir: '',
};

export interface ExecOptions {
  settings: UserSettings;
  workDir?: string;
  timeout?: number;
  extraArgs?: string[];
  signal?: AbortSignal;
}

export interface ExecResult {
  text: string;
  sessionId?: string;
  cost?: number;
  duration?: number;
  error?: boolean;
}

export interface AdapterCapabilities {
  streaming: boolean;
  jsonOutput: boolean;
  sessionResume: boolean;
  modes: ToolMode[];
  hasEffort: boolean;
  hasModel: boolean;
  hasSearch: boolean;
  hasBudget: boolean;
}

export interface CLIAdapter {
  readonly name: string;
  readonly displayName: string;
  readonly command: string;
  readonly capabilities: AdapterCapabilities;
  isAvailable(): Promise<boolean>;
  execute(prompt: string, opts: ExecOptions): Promise<ExecResult>;
}
