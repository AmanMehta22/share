import { Check } from 'lucide-react';

/**
 * Horizontal step chips showing where the user is in the flow.
 *
 * @param {{steps: Array<{key:string, label:string}>, current: string}} props
 * `current` is a step key; every step before it renders as done, the
 * matching one as active, later ones as neutral.
 */
export function FlowSteps({ steps, current }) {
  const currentIndex = steps.findIndex((step) => step.key === current);

  return (
    <nav className="flow-steps" aria-label="Progress">
      {steps.map((step, index) => {
        const state =
          index < currentIndex ? 'done' : index === currentIndex ? 'active' : 'todo';
        return (
          <span key={step.key} className={`flow-chip ${state === 'todo' ? '' : state}`}>
            {state === 'done' && <Check size={13} aria-hidden="true" />}
            {step.label}
            {index < steps.length - 1 && <span aria-hidden="true"> →</span>}
          </span>
        );
      })}
    </nav>
  );
}
