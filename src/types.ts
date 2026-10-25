export type EntityKind = 'Project' | 'Idea' | 'Claim' | 'Experiment' | 'Artifact' | 'Note' | 'Paper';
export const paperStatuses = ['To read', 'Reading', 'Read'] as const;
export type ClaimStatus = 'Open' | 'Supported' | 'Mixed' | 'Refuted';
export interface SourceRef { path?: string; url?: string; label?: string; line?: number; symbol?: string; revision?: string; reviewedHash?: string }
export interface Link { target: string; relation: string }
export interface Entity {
  id: string;
  kind: EntityKind;
  title: string;
  projectIds: string[];
  status: string;
  revision: number;
  createdAt: string;
  updatedAt: string;
  links: Link[];
  sources: SourceRef[];
  metadata: Record<string, any>;
  body: string;
  filePath?: string;
  contentHash?: string;
}
export interface GraphNode { id: string; label: string; subtitle?: string; status?: string; kind?: string; entityId?: string; source?: SourceRef; description?: string }
export interface GraphEdge { id: string; source: string; target: string; label?: string; inferred?: boolean }
export interface CodeGraph { nodes: GraphNode[]; edges: GraphEdge[]; revision: string; mode: 'data' | 'modules'; stale?: boolean; generatedAt: string }
export type Section = 'Overview' | 'Ideas' | 'Experiments' | 'Related work' | 'Source Code' | 'Report' | 'Files';
export interface AppState {
  projects: Entity[];
  entities: Entity[];
  selectedProjectId: string;
  selectedSourceRoot?: string;
  section: Section;
  graph?: CodeGraph;
  runs?: any[];
  report?: any;
  files?: any[];
  errors: string[];
  loading?: boolean;
  driveConnected?: boolean;
  memoryRoot?: string;
}
export interface BridgeMessage { command: string; payload?: any; requestId?: string; clientId?: string; sequence?: number }

export const navigationCommands = new Set(['selectProject', 'selectSection', 'selectSource', 'codeMode']);

export interface SourcePreview {
  source: SourceRef;
  kind: 'image' | 'table' | 'markdown' | 'json' | 'text' | 'unsupported' | 'error';
  dataUrl?: string;
  text?: string;
  columns?: string[];
  rows?: string[][];
  truncated?: boolean;
  message?: string;
  caption?: string;
  readingGuide?: string;
  group?: string;
  role?: 'setup' | 'result' | 'supplement';
  images?: Record<string, string>;
}
export interface PreviewRecord {
  entity: Entity;
  sources: SourcePreview[];
  images?: Record<string, string>;
}
export interface EntityPreview {
  entityId: string;
  records: PreviewRecord[];
  truncated?: boolean;
}
