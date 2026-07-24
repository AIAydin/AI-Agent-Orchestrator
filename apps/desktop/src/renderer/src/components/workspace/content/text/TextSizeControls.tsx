import { useAgentSession } from '../../runs/agent-session/AgentSessionContext.js';

const SIZES = [
  { value: 's', label: 'S', description: 'Small text' },
  { value: 'm', label: 'M', description: 'Medium text' },
  { value: 'l', label: 'L', description: 'Large text' },
] as const;

export function TextSizeControls({
  id,
  fontSize,
}: {
  readonly id: string;
  readonly fontSize: 's' | 'm' | 'l';
}) {
  const session = useAgentSession();
  return (
    <span className="text-size-controls" role="group" aria-label="Text size">
      {SIZES.map((size) => (
        <button
          key={size.value}
          type="button"
          className={fontSize === size.value ? 'text-size-button active' : 'text-size-button'}
          aria-label={size.description}
          aria-pressed={fontSize === size.value}
          onClick={(event) => {
            event.stopPropagation();
            session.recordHistory();
            session.updateNodeData(id, { fontSize: size.value });
          }}
        >
          {size.label}
        </button>
      ))}
    </span>
  );
}
