import { useEffect, useId, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import Spinner from './Spinner';
import { getErrorMessage } from '../../utils/error';

interface ActionButtonProps {
  action: () => Promise<string | void>;
  label: string;
  pendingLabel: string;
  successLabel: string;
  errorLabel: string;
  disabled?: boolean;
  contextKey?: string;
  className?: string;
}

// Keep async feedback at the initiating control, without a floating overlay.
export default function ActionButton({
  action, label, pendingLabel, successLabel, errorLabel,
  disabled = false, contextKey, className = '',
}: ActionButtonProps) {
  const { t } = useTranslation();
  const [phase, setPhase] = useState<'idle' | 'pending' | 'success' | 'error'>('idle');
  const [result, setResult] = useState('');
  const [error, setError] = useState('');
  const generation = useRef(0);
  const running = useRef(false);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const detailsId = useId();

  useEffect(() => {
    generation.current++;
    running.current = false;
    clearTimeout(timer.current);
    setPhase('idle');
    setError('');
    return () => {
      generation.current++;
      clearTimeout(timer.current);
    };
  }, [contextKey]);

  async function handleClick() {
    if (disabled || running.current) return;
    running.current = true;
    clearTimeout(timer.current);
    const current = ++generation.current;
    setPhase('pending');
    setError('');
    try {
      const message = await action();
      if (current !== generation.current) return;
      setResult(message || successLabel);
      setPhase('success');
      timer.current = setTimeout(() => setPhase('idle'), 2400);
    } catch (cause) {
      if (current !== generation.current) return;
      setError(getErrorMessage(cause, errorLabel));
      setPhase('error');
    } finally {
      if (current === generation.current) running.current = false;
    }
  }

  const message = phase === 'pending' ? pendingLabel
    : phase === 'success' ? result : phase === 'error' ? t('common.actionFailed') : label;

  return (
    <div className="inline-flex max-w-full flex-col items-start gap-1.5 align-top">
      <button
        type="button"
        onClick={handleClick}
        disabled={disabled || phase === 'pending'}
        aria-busy={phase === 'pending'}
        aria-label={phase === 'idle' ? label : `${label}: ${message}`}
        aria-describedby={phase === 'error' ? detailsId : undefined}
        data-feedback={phase}
        className={`action-button ${className}`}
      >
        <span className="grid items-center justify-items-center">
          {/* Reserve the state labels so neighbours do not move on each click. */}
          <span aria-hidden="true" className="invisible col-start-1 row-start-1 whitespace-nowrap">{label}</span>
          <span aria-hidden="true" className="invisible col-start-1 row-start-1 inline-flex items-center gap-2 whitespace-nowrap"><span className="size-4" />{successLabel}</span>
          <span key={phase} className="action-button-content col-start-1 row-start-1 inline-flex items-center gap-2 whitespace-nowrap">
            {phase === 'pending' && <Spinner />}
            {(phase === 'success' || phase === 'error') && (
              <svg className="size-4 shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth="2" aria-hidden="true">
                <path className={phase === 'success' ? 'action-check' : undefined} strokeLinecap="round" strokeLinejoin="round" d={phase === 'success' ? 'M5 12l4 4L19 6' : 'M6 6l12 12M18 6L6 18'} />
              </svg>
            )}
            {phase !== 'pending' && message}
          </span>
        </span>
      </button>
      <span className="sr-only" role="status" aria-live="polite" aria-atomic="true">
        {phase === 'success' ? `${label}: ${result}` : ''}
      </span>
      <span className="sr-only" role="alert" aria-atomic="true">{phase === 'error' ? errorLabel : ''}</span>
      {phase === 'error' && (
        <details id={detailsId} className="action-error w-0 min-w-full text-xs text-red-600 dark:text-red-400">
          <summary className="cursor-pointer py-1 focus-visible:outline-2 focus-visible:outline-offset-2">{t('common.errorDetails')}</summary>
          <p role="alert" className="max-h-40 overflow-y-auto pt-1 leading-relaxed [overflow-wrap:anywhere]">{error}</p>
        </details>
      )}
    </div>
  );
}
