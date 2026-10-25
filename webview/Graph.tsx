import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { Background, Controls, Handle, Position, ReactFlow, ReactFlowProvider, useNodesInitialized, useReactFlow, type NodeProps, type Node, type Edge } from '@xyflow/react';
import ELK from 'elkjs/lib/elk.bundled.js';
import type { Entity, GraphEdge, GraphNode } from '../src/types.js';
import { isBackBurner } from '../src/workflow.js';
import { InlineMath } from './Markdown.js';

export interface MapData { nodes: GraphNode[]; edges: GraphEdge[]; authored?: boolean }
type CardData = GraphNode & { children: number; collapsed: boolean; selected: boolean; onToggle: (id: string) => void; onSelect: (id: string) => void; [key: string]: unknown };
type CardNode = Node<CardData, 'card'>;
const elk = new ELK();
type LayoutPositions = Map<string, { x: number; y: number }>;
interface LayoutEntry { promise: Promise<LayoutPositions>; positions?: LayoutPositions }
const layoutCache = new Map<string, LayoutEntry>();
const layoutKey = (data: MapData) => JSON.stringify([data.nodes.map(node => node.id), data.edges.map(edge => [edge.id, edge.source, edge.target])]);

export const CARD = { width: 352, height: 106 };
const MARGIN = { x: 90, y: 24 };

/** Authored maps with a chain of claims: claims in one column, each claim's tests to its right, children further right. */
export function spineLayout(data: MapData): LayoutPositions | undefined {
  const claims = data.nodes.filter(node => node.kind === 'Claim');
  if (!data.authored || claims.length < 2) return undefined;
  const kind = new Map(data.nodes.map(node => [node.id, node.kind]));
  const gapX = 190, gapY = 30, rowGap = 26, positions: LayoutPositions = new Map();
  const isClaim = (id: string) => kind.get(id) === 'Claim';
  // a record tested by a claim sits next to that claim, even if it is also another record's child
  const tested = new Set(data.edges.filter(edge => isClaim(edge.source) && !isClaim(edge.target)).map(edge => edge.target));
  const children = (id: string) => data.edges.filter(edge => edge.source === id && !isClaim(edge.target) && kind.get(edge.target) !== 'Project' && (isClaim(id) || !tested.has(edge.target))).map(edge => edge.target);
  const place = (id: string, column: number, top: number): number => {
    if (positions.has(id)) return top;
    positions.set(id, { x: MARGIN.x + column * (CARD.width + gapX), y: MARGIN.y + top });
    let next = top, bottom = top + CARD.height + gapY;
    for (const child of children(id)) { next = place(child, column + 1, next); bottom = Math.max(bottom, next); }
    return bottom;
  };
  let y = 0;
  for (const node of data.nodes.filter(item => item.kind === 'Project')) { positions.set(node.id, { x: MARGIN.x, y: MARGIN.y + y }); y += CARD.height + gapY + rowGap; }
  for (const claim of claims) y = place(claim.id, 0, y) + rowGap;
  for (const node of data.nodes) if (!positions.has(node.id)) y = place(node.id, 1, y);
  return positions;
}

export function layoutMap(data: MapData): Promise<LayoutPositions> {
  const spine = spineLayout(data);
  if (spine) return Promise.resolve(spine);
  const key = layoutKey(data);
  const cached = layoutCache.get(key);
  if (cached) {
    layoutCache.delete(key); layoutCache.set(key, cached);
    return cached.promise;
  }
  const entry: LayoutEntry = { promise: elk.layout({
    id: 'root', layoutOptions: { 'elk.algorithm': 'layered', 'elk.direction': 'RIGHT', 'elk.edgeRouting': 'ORTHOGONAL', 'elk.layered.spacing.nodeNodeBetweenLayers': '76', 'elk.spacing.nodeNode': '20', 'elk.padding': '[top=36,left=36,bottom=36,right=36]' },
    children: data.nodes.map(node => ({ id: node.id, width: CARD.width, height: CARD.height })),
    edges: data.edges.map(edge => ({ id: edge.id, sources: [edge.source], targets: [edge.target] })),
  }).then(layout => {
    entry.positions = new Map(layout.children?.map(node => [node.id, { x: node.x || 0, y: node.y || 0 }]));
    return entry.positions;
  }).catch(error => {
    if (layoutCache.get(key) === entry) layoutCache.delete(key);
    throw error;
  }) };
  layoutCache.set(key, entry);
  if (layoutCache.size > 24) layoutCache.delete(layoutCache.keys().next().value!);
  return entry.promise;
}

export function statusTone(status = ''): string {
  if (/review|mixed|partial|pending|stale|unknown/i.test(status)) return 'amber';
  if (/supported|complete|succeeded|valid|running|active/i.test(status) && !/invalid/i.test(status)) return 'green';
  if (/refuted|failed|invalid|error|cancel|superseded/i.test(status)) return 'red';
  return 'muted';
}

export function researchMap(project: Entity | undefined, entities: Entity[], section: string): MapData {
  if (!project) return { nodes: [], edges: [] };
  const flow = project.metadata.researchFlow;
  if ((section === 'Overview' || section === 'Experiments') && flow?.version === 1 && Array.isArray(flow.nodeIds) && Array.isArray(flow.edges)) {
    const byId = new Map([project, ...entities.filter(entity => entity.projectIds.includes(project.id))].map(entity => [entity.id, entity]));
    const selectedIds = section === 'Overview' && Array.isArray(flow.overviewNodeIds) ? flow.overviewNodeIds : [project.id, ...flow.nodeIds];
    const ids = [...new Set<string>(selectedIds.filter((id: unknown): id is string => typeof id === 'string' && !(byId.has(id) && isBackBurner(byId.get(id)!))))];
    const nodes: GraphNode[] = ids.map(id => {
      const entity = byId.get(id);
      if (!entity) return { id, label: id, kind: 'Missing record', status: 'Needs review', subtitle: 'Authored flow reference is missing' };
      return { id, entityId: id, label: entity.title, kind: entity.kind, status: entity.metadata.needsReview ? 'Needs review' : entity.status,
        subtitle: (entity.kind === 'Claim' && entity.metadata.answer) || entity.metadata.conditions || entity.metadata.researchRole || entity.kind, description: entity.body };
    });
    const visible = new Set(ids);
    const edges: GraphEdge[] = flow.edges.filter((edge: any) => edge && visible.has(edge.source) && visible.has(edge.target) && edge.source !== edge.target)
      .map((edge: any, index: number) => ({ id: `flow:${index}:${edge.source}:${edge.target}`, source: edge.source, target: edge.target, label: String(edge.label || '') }));
    return { nodes, edges, authored: true };
  }
  let selected = entities.filter(entity => entity.projectIds.includes(project.id) && entity.kind !== 'Project' && entity.kind !== 'Note' && entity.kind !== 'Paper' && (section === 'Experiments' || entity.kind !== 'Idea'));
  const ids = new Set([project.id, ...selected.map(entity => entity.id)]);
  const byId = new Map([project, ...selected].map(entity => [entity.id, entity]));
  let nodes = [project, ...selected].map(entity => {
    const subtitle = entity.kind === 'Project' ? 'Research method' : entity.kind === 'Claim' && (entity.metadata.conditions ?? entity.metadata.scope) ? String(entity.metadata.conditions ?? entity.metadata.scope) : `${entity.kind}${entity.metadata.imported ? ' · Imported record' : ''}`;
    return {
      id: entity.id, entityId: entity.id, label: entity.title, kind: entity.kind,
      status: entity.metadata.needsReview ? 'Needs review' : entity.status,
      subtitle: `${subtitle}${isBackBurner(entity) ? ' · Back burner' : ''}`,
      description: entity.body,
    };
  });
  const rank: Record<string, number> = { Project: 0, Idea: 1, Claim: 2, Experiment: 3, Artifact: 4, Note: 5 };
  const edges: GraphEdge[] = [];
  const seen = new Set<string>();
  for (const entity of [project, ...selected]) {
    for (const link of entity.links) {
      if (!ids.has(link.target) || link.target === entity.id) continue;
      let source = entity.id, target = link.target;
      const other = byId.get(link.target)!;
      if (/^(parent|part_of|subclaim_of|belongs_to|under|depends_on)$/.test(link.relation) || rank[entity.kind] > rank[other.kind]) [source, target] = [target, source];
      if (seen.has(`${source}:${target}`)) continue;
      seen.add(`${source}:${target}`);
      edges.push({ id: `${source}:${target}`, source, target, label: link.relation.replaceAll('_', ' ') });
    }
  }
  if (section === 'Experiments') {
    const hidden = new Set(selected.filter(isBackBurner).map(entity => entity.id));
    const artifacts = new Set(selected.filter(entity => entity.kind === 'Artifact').map(entity => entity.id));
    const attachedArtifacts = (parents: Entity[]) => {
      const attached = new Set<string>();
      const visit = (id: string) => {
        for (const edge of edges.filter(edge => edge.source === id && artifacts.has(edge.target))) {
          if (attached.has(edge.target)) continue;
          attached.add(edge.target); visit(edge.target);
        }
      };
      parents.forEach(entity => visit(entity.id));
      return attached;
    };
    const parkedArtifacts = attachedArtifacts(selected.filter(entity => entity.kind === 'Experiment' && hidden.has(entity.id)));
    const visibleArtifacts = attachedArtifacts(selected.filter(entity => entity.kind === 'Claim' || entity.kind === 'Experiment' && !hidden.has(entity.id)));
    parkedArtifacts.forEach(id => { if (!visibleArtifacts.has(id)) hidden.add(id); });
    selected = selected.filter(entity => !hidden.has(entity.id));
    nodes = nodes.filter(node => !hidden.has(node.id));
    edges.splice(0, edges.length, ...edges.filter(edge => !hidden.has(edge.source) && !hidden.has(edge.target)));
  }
  if (section === 'Overview') {
    const relevant = new Set([project.id]);
    const include = (id: string) => { if (relevant.has(id)) return; relevant.add(id); edges.filter(edge => edge.source === id).forEach(edge => include(edge.target)); };
    selected.filter(entity => entity.kind === 'Claim').forEach(entity => include(entity.id));
    nodes = nodes.filter(node => relevant.has(node.id));
    selected = selected.filter(entity => relevant.has(entity.id));
    const relevantEdges = edges.filter(edge => relevant.has(edge.source) && relevant.has(edge.target));
    edges.splice(0, edges.length, ...relevantEdges);
  }
  const reachable = new Set([project.id]);
  const visit = (id: string) => { for (const edge of edges.filter(item => item.source === id)) if (!reachable.has(edge.target)) { reachable.add(edge.target); visit(edge.target); } };
  visit(project.id);
  const incoming = new Set(edges.map(edge => edge.target));
  for (const entity of selected.filter(item => !incoming.has(item.id))) {
    if (!reachable.has(entity.id)) { edges.push({ id: `root:${entity.id}`, source: project.id, target: entity.id }); reachable.add(entity.id); visit(entity.id); }
  }
  for (const entity of selected) if (!reachable.has(entity.id)) { edges.push({ id: `root:${entity.id}`, source: project.id, target: entity.id }); reachable.add(entity.id); visit(entity.id); }
  return { nodes, edges };
}

function MapCard({ data }: NodeProps<CardNode>) {
  return <div className={`map-card ${data.selected ? 'is-selected' : ''}`}>
    <Handle type="target" id="l" position={Position.Left} isConnectable={false} />
    <Handle type="target" id="t" position={Position.Top} isConnectable={false} />
    <button className="card-main" onClick={event => { event.stopPropagation(); data.onSelect(data.id); }} title={data.label} aria-label={`${data.label}, ${data.status || data.kind || 'node'}`}>
      <span className={`status-dot ${statusTone(data.status)}`} />
      <span className="card-copy"><strong><InlineMath text={data.label} /></strong><span>{data.status ? `${data.status} · ` : ''}<InlineMath text={String(data.subtitle || data.kind || '')} /></span></span>
      {data.status === 'Needs review' && <span className="review-marker" title="Needs review">!</span>}
    </button>
    {data.children > 0 && <button className="fold-control" onClick={event => { event.stopPropagation(); data.onToggle(data.id); }} aria-label={`${data.collapsed ? 'Expand' : 'Collapse'} ${data.label}`} title={`${data.collapsed ? 'Expand' : 'Collapse'} ${data.children} connections`}>{data.collapsed ? '+' : '−'}<span>{data.children}</span></button>}
    <Handle type="source" id="r" position={Position.Right} isConnectable={false} />
    <Handle type="target" id="rt" position={Position.Right} isConnectable={false} />
    <Handle type="source" id="b" position={Position.Bottom} isConnectable={false} />
  </div>;
}
const nodeTypes = { card: MapCard };

interface MapProps { data: MapData; selectedId: string; onSelect: (id: string) => void; identity: string; query: string }
function MapCanvas({ data, selectedId, onSelect, query }: MapProps) {
  const initialCollapse = useMemo(() => {
    if (data.authored) return new Set<string>();
    const targets = new Set(data.edges.map(edge => edge.target));
    const roots = data.nodes.filter(node => !targets.has(node.id));
    const depth = new Map<string, number>();
    const queue = (roots.length ? roots : data.nodes.slice(0, 1)).map(node => ({ id: node.id, depth: 0 }));
    while (queue.length) {
      const item = queue.shift()!;
      if (depth.has(item.id)) continue;
      depth.set(item.id, item.depth);
      data.edges.filter(edge => edge.source === item.id).forEach(edge => queue.push({ id: edge.target, depth: item.depth + 1 }));
    }
    const level = data.nodes.length > 30 || window.innerWidth < 850 ? 1 : 2;
    return new Set(data.nodes.filter(node => (depth.get(node.id) || 0) >= level && data.edges.some(edge => edge.source === node.id)).map(node => node.id));
  }, [data]);
  const [collapsed, setCollapsed] = useState(initialCollapse);
  const [branchLimits, setBranchLimits] = useState<Map<string, number>>(new Map());
  const [layoutError, setLayoutError] = useState('');
  const [fitRequest, setFitRequest] = useState<'initial' | 'reset' | 'all' | null>('initial');
  const { fitView } = useReactFlow();
  const nodesInitialized = useNodesInitialized();
  const visible = useMemo(() => {
    const children = new Map<string, string[]>();
    const parents = new Map<string, string[]>();
    data.edges.forEach(edge => {
      children.set(edge.source, [...(children.get(edge.source) || []), edge.target]);
      parents.set(edge.target, [...(parents.get(edge.target) || []), edge.source]);
    });
    const roots = data.nodes.filter(node => !parents.has(node.id));
    const shown = new Set<string>();
    const branchEdges: GraphEdge[] = [];
    const moreNodes: GraphNode[] = [];
    const visit = (id: string) => {
      if (shown.has(id)) return;
      shown.add(id);
      if (collapsed.has(id)) return;
      const outgoing = data.edges.filter(item => item.source === id && !shown.has(item.target));
      const limit = branchLimits.get(id) ?? 6;
      for (const edge of outgoing.slice(0, limit)) {
        if (shown.has(edge.target)) continue;
        branchEdges.push(edge); visit(edge.target);
      }
      if (outgoing.length > limit) {
        const moreId = `more:${id}`;
        moreNodes.push({ id: moreId, label: `${outgoing.length - limit} more connections`, subtitle: 'Click to show the next six', kind: 'more' });
        branchEdges.push({ id: moreId, source: id, target: moreId });
      }
    };
    (roots.length ? roots : data.nodes.slice(0, 1)).forEach(root => visit(root.id));
    let keep = shown;
    if (query.trim()) {
      keep = new Set<string>();
      const includeAncestors = (id: string) => { if (keep.has(id)) return; keep.add(id); (parents.get(id) || []).forEach(includeAncestors); };
      data.nodes.filter(node => `${node.label} ${node.subtitle} ${node.status}`.toLowerCase().includes(query.toLowerCase())).forEach(node => includeAncestors(node.id));
      return { nodes: data.nodes.filter(node => keep.has(node.id)), edges: data.edges.filter(edge => keep.has(edge.source) && keep.has(edge.target)), children };
    }
    // authored maps keep every authored edge between shown nodes (child links are not tree edges)
    const extra = data.authored ? data.edges.filter(edge => keep.has(edge.source) && keep.has(edge.target) && !branchEdges.some(item => item.id === edge.id)) : [];
    return { nodes: [...data.nodes.filter(node => keep.has(node.id)), ...moreNodes], edges: [...branchEdges, ...extra], children };
  }, [data, collapsed, query, branchLimits]);
  const geometryKey = layoutKey(visible);
  const [geometry, setGeometry] = useState<{ key: string; positions: LayoutPositions; visible: typeof visible }>();
  const positions = geometry?.key === geometryKey ? geometry.positions : layoutCache.get(geometryKey)?.positions;
  const layoutBusy = !positions && !layoutError;
  useEffect(() => {
    let active = true;
    setLayoutError('');
    layoutMap({ ...visible, authored: data.authored }).then(positions => {
      if (!active) return;
      setGeometry({ key: geometryKey, positions, visible });
    }).catch(error => { if (active) setLayoutError(String(error)); });
    return () => { active = false; };
  }, [geometryKey]);
  useEffect(() => {
    if (!fitRequest || !positions || !nodesInitialized) return;
    const frame = requestAnimationFrame(() => {
      void fitView({ padding: 0.13, ...(fitRequest === 'all' ? {} : { minZoom: data.authored ? 0.18 : 0.62, maxZoom: 1 }), duration: fitRequest === 'initial' ? 0 : 250 });
      setFitRequest(null);
    });
    return () => cancelAnimationFrame(frame);
  }, [fitRequest, positions, nodesInitialized, fitView, data.authored]);
  const selectNode = useCallback((id: string) => {
    if (id.startsWith('more:')) { const parent = id.slice(5); setBranchLimits(previous => new Map(previous).set(parent, (previous.get(parent) ?? 6) + 6)); }
    else onSelect(id);
  }, [onSelect]);
  const toggleNode = useCallback((id: string) => setCollapsed(previous => { const next = new Set(previous); next.has(id) ? next.delete(id) : next.add(id); return next; }), []);
  const displayed = positions ? visible : geometry?.visible;
  const displayedPositions = positions ?? geometry?.positions;
  const renderedNodes = useMemo<CardNode[]>(() => (displayed?.nodes || []).map(node => ({ id: node.id, type: 'card', position: displayedPositions!.get(node.id) || { x: 0, y: 0 }, data: { ...node, children: displayed!.children.get(node.id)?.length || 0, collapsed: collapsed.has(node.id), selected: node.id === selectedId, onSelect: selectNode, onToggle: toggleNode }, width: CARD.width, height: CARD.height })), [displayed, displayedPositions, collapsed, selectedId, selectNode, toggleNode]);
  const spine = useMemo(() => !!spineLayout(data), [data]);
  const kinds = useMemo(() => new Map(data.nodes.map(node => [node.id, node.kind])), [data]);
  const bracketParents = useMemo(() => [...new Set((displayed?.edges || []).filter(edge => spine && displayedPositions?.get(edge.source)?.x === displayedPositions?.get(edge.target)?.x && kinds.get(edge.target) !== 'Claim').map(edge => edge.source))], [displayed, displayedPositions, spine, kinds]);
  const edges = useMemo<Edge[]>(() => (displayed?.edges || []).map(edge => ({ id: edge.id, source: edge.source, target: edge.target, ...(spine && kinds.get(edge.target) === 'Claim' && ['Claim', 'Project'].includes(String(kinds.get(edge.source))) ? { sourceHandle: 'b', targetHandle: 't', type: 'straight' } : spine && displayedPositions?.get(edge.source)?.x === displayedPositions?.get(edge.target)?.x ? { sourceHandle: 'r', targetHandle: 'rt', type: 'smoothstep', pathOptions: { offset: 56 + 44 * bracketParents.indexOf(edge.source) }, style: { stroke: 'var(--muted)', strokeWidth: 1.2, strokeDasharray: '4 3' } } : { sourceHandle: 'r', targetHandle: 'l', type: 'step' }), className: edge.inferred ? 'inferred-edge' : undefined, data: { relation: edge.label }, ...(data.authored ? { label: edge.label, labelStyle: { fontSize: 11, fill: 'var(--fg)' }, labelBgStyle: { fill: 'var(--bg)' }, labelBgPadding: [5, 3] as [number, number] } : {}), animated: false })).map(edge => ({ style: { stroke: 'var(--line)', strokeWidth: 1.4 }, ...edge }) as Edge), [displayed, data.authored, spine, kinds, displayedPositions, bracketParents]);
  return <div className="graph-canvas" aria-label="Research map">
    <ReactFlow nodes={renderedNodes} edges={edges} nodeTypes={nodeTypes} nodesDraggable={false} nodesConnectable={false} nodesFocusable={false} edgesFocusable={false} elementsSelectable={false} minZoom={0.18} maxZoom={1.5} preventScrolling fitViewOptions={{ padding: 0.13 }} proOptions={{ hideAttribution: true }} onNodeClick={(_event, node) => selectNode(node.id)}>
      <Background gap={26} size={1} color="var(--grid)" />
      <Controls showInteractive={false} position="bottom-left" />
    </ReactFlow>
    <div className="map-hint"><span>{visible.nodes.filter(node => node.kind !== 'more').length} of {data.nodes.length} nodes</span><span>Scroll to zoom · Drag to move</span><button className="text-button" onClick={() => { setCollapsed(initialCollapse); setBranchLimits(new Map()); setFitRequest('reset'); }}>Reset view</button><button className="text-button" onClick={() => { setCollapsed(new Set()); setBranchLimits(new Map(data.nodes.map(node => [node.id, Infinity]))); setFitRequest('all'); }}>Expand all</button></div>
    {layoutBusy && <div className="map-loading" role="status">Arranging map…</div>}
    {layoutError && <div className="map-message error" role="alert">Could not arrange this map: {layoutError}</div>}
    {!layoutBusy && !visible.nodes.length && <div className="map-message">{query ? 'No matching nodes. Try a different search.' : 'Add a claim or experiment to start this map.'}</div>}
  </div>;
}

export function ResearchMap(props: MapProps) {
  return <ReactFlowProvider key={`${props.identity}:${props.data.nodes[0]?.id || ''}`}><MapCanvas {...props} /></ReactFlowProvider>;
}
