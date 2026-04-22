import { useEffect, useCallback, useMemo, useState, forwardRef, useImperativeHandle, useRef } from 'react';
import ForceGraph3D from 'react-force-graph-3d';
import * as THREE from 'three';
import {
  Maximize2,
  Focus,
  RotateCcw,
  Lightbulb,
  LightbulbOff,
} from '@/lib/lucide-icons';
import { useAppState } from '../hooks/useAppState';
import {
  knowledgeGraphToGraphology,
  filterGraphByDepth
} from '../lib/graph-adapter';
import type { GraphNode } from 'gitnexus-shared';
import { QueryFAB } from './QueryFAB';
import Graph from 'graphology';

export interface GraphCanvasHandle {
  focusNode: (nodeId: string) => void;
}

export const GraphCanvas = forwardRef<GraphCanvasHandle>((_, ref) => {
  const {
    graph: backendGraph,
    setSelectedNode,
    selectedNode: appSelectedNode,
    visibleLabels,
    visibleEdgeTypes,
    openCodePanel,
    depthFilter,
    highlightedNodeIds,
    aiCitationHighlightedNodeIds,
    aiToolHighlightedNodeIds,
    blastRadiusNodeIds,
    isAIHighlightsEnabled,
    toggleAIHighlights,
    clearAIToolHighlights,
    clearAICitationHighlights,
    clearBlastRadius,
    animatedNodes,
  } = useAppState();

  const [hoveredNodeName, setHoveredNodeName] = useState<string | null>(null);
  const fgRef = useRef<any>();
  const [internalGraph, setInternalGraph] = useState<Graph | null>(null);

  // 生成“锐利核心 + 边缘柔光”贴片，既保持发光感又绝对不糊
  const crispGlowTexture = useMemo(() => {
    const canvas = document.createElement('canvas');
    canvas.width = 128; 
    canvas.height = 128;
    const ctx = canvas.getContext('2d');
    if (ctx) {
      const cx = 64;
      const cy = 64;
      
      // 1. 绘制绝对锐利、无虚化的核心边缘 (Radius: 40)
      ctx.beginPath();
      ctx.arc(cx, cy, 40, 0, 2 * Math.PI, false);
      ctx.fillStyle = 'rgba(255, 255, 255, 1)';
      ctx.fill();

      // 2. 绘制刚好贴着核心边缘的紧凑光晕 (Radius: 40 -> 60)
      const gradient = ctx.createRadialGradient(cx, cy, 40, cx, cy, 60);
      gradient.addColorStop(0, 'rgba(255, 255, 255, 0.4)');
      gradient.addColorStop(1, 'rgba(255, 255, 255, 0)');
      
      ctx.beginPath();
      ctx.arc(cx, cy, 60, 0, 2 * Math.PI, false);
      ctx.fillStyle = gradient;
      ctx.fill();
    }
    const tex = new THREE.CanvasTexture(canvas);
    return tex;
  }, []);
  
  // Create unified graphology object when backend graph changes
  useEffect(() => {
    if (!backendGraph) return;

    const communityMemberships = new Map<string, number>();
    backendGraph.relationships.forEach((rel) => {
      if (rel.type === 'MEMBER_OF') {
        const targetId = rel.targetId;
        const numericPart = targetId.replace('comm_', '');
        const communityIdx = /^\d+$/.test(numericPart) ? parseInt(numericPart, 10) : 0;
        communityMemberships.set(rel.sourceId, communityIdx);
      }
    });

    const sigmaGraph = knowledgeGraphToGraphology(backendGraph, communityMemberships);
    setInternalGraph(sigmaGraph);
  }, [backendGraph]);

  const effectiveHighlightedNodeIds = useMemo(() => {
    if (!isAIHighlightsEnabled) return highlightedNodeIds;
    const next = new Set(highlightedNodeIds);
    for (const id of aiCitationHighlightedNodeIds) next.add(id);
    for (const id of aiToolHighlightedNodeIds) next.add(id);
    return next;
  }, [
    highlightedNodeIds,
    aiCitationHighlightedNodeIds,
    aiToolHighlightedNodeIds,
    isAIHighlightsEnabled,
  ]);

  const effectiveBlastRadiusNodeIds = useMemo(() => {
    if (!isAIHighlightsEnabled) return new Set<string>();
    return blastRadiusNodeIds;
  }, [blastRadiusNodeIds, isAIHighlightsEnabled]);

  const nodeById = useMemo(() => {
    if (!backendGraph) return new Map<string, GraphNode>();
    return new Map(backendGraph.nodes.map((n) => [n.id, n]));
  }, [backendGraph]);

  // Convert graphology to 3D graph format
  const graphData3D = useMemo(() => {
    if (!internalGraph) return { nodes: [], links: [] };

    // Apply filters.
    if (internalGraph.order > 0) {
      filterGraphByDepth(internalGraph as any, appSelectedNode?.id || null, depthFilter, visibleLabels);
    }

    const gNodes: any[] = [];
    internalGraph.forEachNode((node, attr) => {
      if (attr.hidden) return;
      gNodes.push({ id: node, ...attr });
    });

    const gLinks: any[] = [];
    internalGraph.forEachEdge((edge, attr, source, target) => {
      const sourceHidden = internalGraph.getNodeAttribute(source, 'hidden');
      const targetHidden = internalGraph.getNodeAttribute(target, 'hidden');
      
      let visible = true;
      if (visibleEdgeTypes && attr.relationType) {
        if (!visibleEdgeTypes.includes(attr.relationType as any)) visible = false;
      }

      if (!sourceHidden && !targetHidden && !attr.hidden && visible) {
        gLinks.push({ source, target, ...attr });
      }
    });

    return { nodes: gNodes, links: gLinks };
  }, [internalGraph, visibleLabels, depthFilter, appSelectedNode, visibleEdgeTypes]);

  const handleNodeClick = useCallback(
    (node: any) => {
      if (!backendGraph) return;
      const n = nodeById.get(node.id);
      if (n) {
        setSelectedNode(n);
        openCodePanel();
        
        if (fgRef.current) {
          const distance = 100;
          const distRatio = 1 + distance/Math.hypot(node.x, node.y, node.z);
          fgRef.current.cameraPosition(
            { x: node.x * distRatio, y: node.y * distRatio, z: node.z * distRatio },
            node,
            1500
          );
        }
      }
    },
    [backendGraph, nodeById, setSelectedNode, openCodePanel]
  );

  useImperativeHandle(ref, () => ({
    focusNode: (nodeId: string) => {
      if (backendGraph) {
        const node = nodeById.get(nodeId);
        if (node) {
          setSelectedNode(node);
          openCodePanel();
          
          const fgNode = graphData3D.nodes.find(n => n.id === nodeId);
          if (fgRef.current && fgNode) {
            const distance = 100;
            const distRatio = 1 + distance/Math.hypot(fgNode.x||0.1, fgNode.y||0.1, fgNode.z||0.1);
            fgRef.current.cameraPosition(
              { x: fgNode.x * distRatio, y: fgNode.y * distRatio, z: fgNode.z * distRatio },
              fgNode,
              1500
            );
          }
        }
      }
    },
  }), [graphData3D.nodes, backendGraph, nodeById, setSelectedNode, openCodePanel]);

  const handleToggleAIHighlights = useCallback(() => {
    if (isAIHighlightsEnabled) {
      clearAIToolHighlights();
      clearAICitationHighlights();
      clearBlastRadius();
      setSelectedNode(null);
    }
    toggleAIHighlights();
  }, [
    isAIHighlightsEnabled,
    clearAIToolHighlights,
    clearAICitationHighlights,
    clearBlastRadius,
    setSelectedNode,
    toggleAIHighlights,
  ]);

  const resetZoom = useCallback(() => {
    if (fgRef.current) {
      fgRef.current.cameraPosition({ x: 0, y: 0, z: Math.pow(graphData3D.nodes.length, 1/3) * 120 }, { x: 0, y: 0, z: 0 }, 1000);
    }
    setSelectedNode(null);
  }, [setSelectedNode, graphData3D.nodes.length]);

  const handleClearSelection = useCallback(() => {
    resetZoom();
  }, [resetZoom]);

  const handleFocusSelected = useCallback(() => {
    if (appSelectedNode) {
      const fgNode = graphData3D.nodes.find(n => n.id === appSelectedNode.id);
      if (fgRef.current && fgNode) {
        const distance = 100;
        const distRatio = 1 + distance/Math.hypot(fgNode.x||0.1, fgNode.y||0.1, fgNode.z||0.1);
        fgRef.current.cameraPosition(
          { x: fgNode.x * distRatio, y: fgNode.y * distRatio, z: fgNode.z * distRatio },
          fgNode,
          1000
        );
      }
    }
  }, [appSelectedNode, graphData3D.nodes]);

  return (
    <div className="relative h-full w-full bg-black">
      {/* Background purely black as requested */}
      <div className="pointer-events-none absolute inset-0 z-0 bg-black" />

      <div className="absolute inset-0 z-10">
        <ForceGraph3D
          ref={fgRef}
          graphData={graphData3D}
          nodeId="id"
          // Node object creation to give it a solid ball plus a glow sprite
          nodeThreeObject={(node: any) => {
            const isSelected = appSelectedNode?.id === node.id;
            const isBlast = effectiveBlastRadiusNodeIds.has(node.id);
            const isHighlight = effectiveHighlightedNodeIds.has(node.id);
            
            let nodeColor = node.color || '#9ca3af';
            if (isBlast) nodeColor = '#ef4444'; 
            else if (isHighlight) nodeColor = '#06b6d4';
            else if (isSelected) nodeColor = '#ffffff';
            else if (appSelectedNode && !isSelected) nodeColor = '#333344'; // Dim
            
            const size = node.size || 5;

            // 恢复正常的材质渲染逻辑，避免加法混合导致边缘消失
            const material = new THREE.SpriteMaterial({ 
              map: crispGlowTexture,
              color: nodeColor,
              depthWrite: false, // 依然优化性能
              transparent: true
            });
            
            const sprite = new THREE.Sprite(material);
            sprite.scale.set(size * 2, size * 2, 1);
            
            return sprite;
          }}
          onNodeClick={handleNodeClick}
          onNodeHover={(node: any) => {
            if (node) {
              setHoveredNodeName(node.label || node.id);
              document.body.style.cursor = 'pointer';
            } else {
              setHoveredNodeName(null);
              document.body.style.cursor = 'default';
            }
          }}
          linkColor={(link: any) => {
            // 连线改为纯白色
            return '#ffffff';
          }}
          linkWidth={(link: any) => (link.size || 1) * 0.25}
          linkOpacity={0.65}
          backgroundColor="#000000"
        />
      </div>

      {hoveredNodeName && !appSelectedNode && (
        <div className="pointer-events-none absolute top-4 left-1/2 z-20 -translate-x-1/2 animate-fade-in rounded-lg border border-border-subtle bg-elevated/95 px-3 py-1.5 backdrop-blur-sm">
          <span className="font-mono text-sm text-text-primary">{hoveredNodeName}</span>
        </div>
      )}

      {/* Selection info bar */}
      {appSelectedNode && (
        <div className="absolute top-4 left-1/2 z-20 flex -translate-x-1/2 animate-slide-up items-center gap-2 rounded-xl border border-accent/30 bg-accent/20 px-4 py-2 backdrop-blur-sm">
          <div className="h-2 w-2 animate-pulse rounded-full bg-accent" />
          <span className="font-mono text-sm text-text-primary">
            {appSelectedNode.properties.name}
          </span>
          <span className="text-xs text-text-muted">({appSelectedNode.label})</span>
          <button
            onClick={handleClearSelection}
            className="ml-2 rounded px-2 py-0.5 text-xs text-text-secondary transition-colors hover:bg-white/10 hover:text-text-primary"
          >
            Clear
          </button>
        </div>
      )}

      {/* Graph Controls - Bottom Right */}
      <div className="absolute right-4 bottom-4 z-20 flex flex-col gap-1">
        <button
          onClick={resetZoom}
          className="flex h-9 w-9 items-center justify-center rounded-md border border-border-subtle bg-elevated text-text-secondary transition-colors hover:bg-hover hover:text-text-primary"
          title="Fit to Screen"
        >
          <Maximize2 className="h-4 w-4" />
        </button>

        <div className="my-1 h-px bg-border-subtle" />

        {appSelectedNode && (
          <button
            onClick={handleFocusSelected}
            className="flex h-9 w-9 items-center justify-center rounded-md border border-accent/30 bg-accent/20 text-accent transition-colors hover:bg-accent/30"
            title="Focus on Selected Node"
          >
            <Focus className="h-4 w-4" />
          </button>
        )}

        {appSelectedNode && (
          <button
            onClick={handleClearSelection}
            className="flex h-9 w-9 items-center justify-center rounded-md border border-border-subtle bg-elevated text-text-secondary transition-colors hover:bg-hover hover:text-text-primary"
            title="Clear Selection"
          >
            <RotateCcw className="h-4 w-4" />
          </button>
        )}
      </div>

      <QueryFAB />

      <div className="absolute top-4 right-4 z-20">
        <button
          onClick={handleToggleAIHighlights}
          className={
            isAIHighlightsEnabled
              ? 'flex h-10 w-10 items-center justify-center rounded-lg border border-cyan-400/40 bg-cyan-500/15 text-cyan-200 transition-colors hover:border-cyan-300/60 hover:bg-cyan-500/20'
              : 'flex h-10 w-10 items-center justify-center rounded-lg border border-border-subtle bg-elevated text-text-muted transition-colors hover:bg-hover hover:text-text-primary'
          }
          title={isAIHighlightsEnabled ? 'Turn off all highlights' : 'Turn on AI highlights'}
          data-testid="ai-highlights-toggle"
        >
          {isAIHighlightsEnabled ? (
            <Lightbulb className="h-4 w-4" />
          ) : (
            <LightbulbOff className="h-4 w-4" />
          )}
        </button>
      </div>
    </div>
  );
});

GraphCanvas.displayName = 'GraphCanvas';
