import { useEffect, useRef, useState } from 'react';
import Spinner from './Spinner';
import { useToastStore } from '../../store/toast';
import { getErrorMessage } from '../../utils/error';

interface ActionButtonProps {
  action: () => Promise<string | void>;
  label: string;
  pendingLabel: string;
  successLabel: string;
  errorLabel: string;
  disabled?: boolean;
  pending?: boolean;
  type?: 'button' | 'submit';
  contextKey?: string;
  className?: string;
}

// Keep loading/success at the control; failures use the existing notification bar.
export default function ActionButton({
  action, label, pendingLabel, successLabel, errorLabel,
  disabled = false, pending = false, type = 'button', contextKey, className = '',
}: ActionButtonProps) {
  const addToast = useToastStore((state) => state.addToast);
  const [phase, setPhase] = useState<'idle' | 'pending' | 'success'>('idle');
  const [result, setResult] = useState('');
  const generation = useRef(0);
  const running = useRef(false);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  useEffect(() => {
    generation.current++;
    running.current = false;
    clearTimeout(timer.current);
    setPhase('idle');
    return () => {
      generation.current++;
      clearTimeout(timer.current);
    };
  }, [contextKey]);

  async function handleClick() {
    if (disabled || pending || running.current) return;
    running.current = true;
    clearTimeout(timer.current);
    const current = ++generation.current;
    setPhase('pending');
    try {
      const message = await action();
      if (current !== generation.current) return;
      setResult(message || successLabel);
      setPhase('success');
      timer.current = setTimeout(() => setPhase('idle'), 2400);
    } catch (cause) {
      if (current !== generation.current) return;
      addToast(getErrorMessage(cause, errorLabel), 'error', errorLabel);
      setPhase('idle');
    } finally {
      if (current === generation.current) running.current = false;
    }
  }

  const visiblePhase = pending ? 'pending' : phase;
  const message = visiblePhase === 'pending' ? pendingLabel
    : visiblePhase === 'success' ? result : label;

  return (
    <div className="inline-flex max-w-full flex-col items-start gap-1.5 align-top">
      <button
        type={type}
        onClick={handleClick}
        disabled={disabled || visiblePhase === 'pending'}
        aria-busy={visiblePhase === 'pending'}
        aria-label={visiblePhase === 'idle' ? label : `${label}: ${message}`}
        data-feedback={visiblePhase}
        className={`action-button ${className}`}
      >
        <span className="grid items-center justify-items-center">
          {/* Reserve the state labels so neighbours do not move on each click. */}
          <span aria-hidden="true" className="invisible col-start-1 row-start-1 whitespace-nowrap">{label}</span>
          <span aria-hidden="true" className="invisible col-start-1 row-start-1 inline-flex items-center gap-2 whitespace-nowrap"><span className="size-4" />{successLabel}</span>
          <span key={visiblePhase} className="action-button-content col-start-1 row-start-1 inline-flex items-center gap-2 whitespace-nowrap">
            {visiblePhase === 'pending' && <Spinner />}
            {visiblePhase === 'success' && (
              <svg className="size-4 shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth="2" aria-hidden="true">
                <path className="action-check" strokeLinecap="round" strokeLinejoin="round" d="M5 12l4 4L19 6" />
              </svg>
            )}
            {visiblePhase !== 'pending' && message}
          </span>
        </span>
      </button>
      <span className="sr-only" role="status" aria-live="polite" aria-atomic="true">
        {visiblePhase === 'success' ? `${label}: ${result}` : ''}
      </span>
    </div>
  );
}
