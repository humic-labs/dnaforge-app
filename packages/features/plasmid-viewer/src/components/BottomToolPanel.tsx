import { useState, useCallback } from 'react';

export interface ToolConfig {
  id: string;
  label: string;
  icon?: string | React.ReactNode;
  component: React.ReactNode;
}

export interface BottomToolPanelProps {
  tools: ToolConfig[];
  defaultExpandedTool?: string;
  expandedHeight?: number;
  hideHeader?: boolean;
  className?: string;
  style?: React.CSSProperties;
}

export function BottomToolPanel({
  tools,
  defaultExpandedTool,
  expandedHeight = 200,
  hideHeader = false,
  className,
  style,
}: BottomToolPanelProps): JSX.Element {
  const [expandedToolId, setExpandedToolId] = useState<string | null>(defaultExpandedTool || null);

  const handleToolClick = useCallback((toolId: string) => {
    setExpandedToolId((current) => (current === toolId ? null : toolId));
  }, []);

  const expandedTool = tools.find((t) => t.id === expandedToolId);
  const isExpanded = expandedTool !== undefined;

  const toolToShow =
    hideHeader && defaultExpandedTool
      ? tools.find((t) => t.id === defaultExpandedTool)
      : expandedTool;

  return (
    <div
      className={className}
      style={{
        display: 'flex',
        flexDirection: 'column',
        borderTop: '1px solid hsl(var(--color-border))',
        backgroundColor: 'hsl(var(--color-bg-subtle))',
        transition: 'height 0.2s ease',
        flexShrink: 0,
        ...style,
      }}
    >
      {}
      {!hideHeader && (
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: '2px',
            padding: '4px 8px',
            borderBottom: isExpanded ? '1px solid hsl(var(--color-border))' : 'none',
            backgroundColor: 'hsl(var(--color-bg-muted))',
          }}
        >
          {tools.map((tool) => {
            const isActive = expandedToolId === tool.id;
            return (
              <button
                key={tool.id}
                onClick={() => handleToolClick(tool.id)}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: '4px',
                  padding: '4px 10px',
                  fontSize: '12px',
                  fontWeight: isActive ? 600 : 400,
                  color: isActive ? 'hsl(var(--color-fg))' : 'hsl(var(--color-fg-subtle))',
                  backgroundColor: isActive ? 'hsl(var(--color-bg))' : 'transparent',
                  border: isActive ? '1px solid hsl(var(--color-border))' : '1px solid transparent',
                  borderBottom: isActive
                    ? '1px solid hsl(var(--color-bg))'
                    : '1px solid transparent',
                  borderRadius: '4px 4px 0 0',
                  cursor: 'pointer',
                  marginBottom: isActive ? '-1px' : 0,
                  transition: 'all 0.15s ease',
                }}
              >
                {tool.icon &&
                  (typeof tool.icon === 'string' ? <span>{tool.icon}</span> : tool.icon)}
                {tool.label}
                <span
                  style={{
                    fontSize: '10px',
                    marginLeft: '2px',
                    color: 'hsl(var(--color-fg-subtle))',
                    transform: isActive ? 'rotate(180deg)' : 'rotate(0deg)',
                    transition: 'transform 0.2s ease',
                  }}
                >
                  ▼
                </span>
              </button>
            );
          })}

          {}
          <div style={{ flex: 1 }} />

          {}
          {isExpanded && (
            <button
              onClick={() => setExpandedToolId(null)}
              style={{
                padding: '4px 8px',
                fontSize: '11px',
                color: 'hsl(var(--color-fg-subtle))',
                backgroundColor: 'transparent',
                border: 'none',
                cursor: 'pointer',
              }}
            >
              Collapse
            </button>
          )}
        </div>
      )}

      {}
      {toolToShow && (
        <div
          style={{
            height: expandedHeight,
            overflow: 'hidden',
          }}
        >
          {toolToShow.component}
        </div>
      )}
    </div>
  );
}
