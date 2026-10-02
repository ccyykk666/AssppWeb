import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import ActionButton from '../../src/components/common/ActionButton';
import { useToastStore } from '../../src/store/toast';
import i18n from '../../src/i18n';

const props = {
  label: '获取许可证', pendingLabel: '处理中…', successLabel: '已获取', errorLabel: '获取许可证失败',
  contextKey: 'app:account', className: 'bg-green-600',
};
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}
beforeEach(async () => { vi.useFakeTimers(); useToastStore.setState({ toasts: [] }); await i18n.changeLanguage('zh-CN'); });
afterEach(async () => { cleanup(); vi.useRealTimers(); await i18n.changeLanguage('en-US'); });

describe('local action feedback', () => {
  it('shows pending at the button, blocks duplicate clicks, then restores its label', async () => {
    const pending = deferred<string>();
    const action = vi.fn(() => pending.promise);
    render(<ActionButton {...props} action={action} />);
    const button = screen.getByRole('button', { name: props.label });
    fireEvent.click(button);
    fireEvent.click(button);
    expect(action).toHaveBeenCalledOnce();
    expect(button).toBeDisabled();
    expect(button).toHaveAttribute('aria-busy', 'true');
    await act(async () => pending.resolve('已拥有'));
    expect(button).toHaveAttribute('data-feedback', 'success');
    expect(button).toHaveAccessibleName('获取许可证: 已拥有');
    expect(screen.getByRole('status')).toHaveTextContent('已拥有');
    await act(async () => { vi.advanceTimersByTime(2400); });
    expect(button).toHaveAccessibleName(props.label);
    expect(button).toHaveAttribute('data-feedback', 'idle');
  });

  it('uses a localized error bar without expanding the button row and permits retry', async () => {
    const action = vi.fn().mockRejectedValueOnce(new Error('Request failed with error code 7: Could not connect to server'))
      .mockResolvedValueOnce(undefined);
    render(<ActionButton {...props} action={action} />);
    await act(async () => { fireEvent.click(screen.getByRole('button')); });
    expect(document.querySelector('details')).toBeNull();
    expect(useToastStore.getState().toasts).toEqual([
      expect.objectContaining({ type: 'error', title: props.errorLabel, message: expect.stringContaining('无法连接到服务器') }),
    ]);
    expect(screen.getByRole('button')).toBeEnabled();
    expect(screen.getByRole('button')).toHaveAttribute('data-feedback', 'idle');
    expect(screen.getByRole('button')).toHaveAccessibleName(props.label);
    await act(async () => { fireEvent.click(screen.getByRole('button')); });
    expect(document.querySelector('details')).toBeNull();
    expect(screen.getByRole('button')).toHaveAttribute('data-feedback', 'success');
    expect(useToastStore.getState().toasts).toHaveLength(1);
  });

  it('ignores stale completion after changing account context', async () => {
    const pending = deferred<string>();
    const action = vi.fn(() => pending.promise);
    const { rerender } = render(<ActionButton {...props} action={action} />);
    fireEvent.click(screen.getByRole('button'));
    rerender(<ActionButton {...props} contextKey="app:other-account" action={action} />);
    await act(async () => pending.resolve('已拥有'));
    expect(screen.getByRole('button')).toHaveAttribute('data-feedback', 'idle');
    expect(screen.getByRole('status')).toBeEmptyDOMElement();
  });

  it('cleans up result timers on unmount and respects disabled controls', async () => {
    const action = vi.fn().mockResolvedValue(undefined);
    const { rerender, unmount } = render(<ActionButton {...props} disabled action={action} />);
    fireEvent.click(screen.getByRole('button'));
    expect(action).not.toHaveBeenCalled();
    rerender(<ActionButton {...props} action={action} />);
    await act(async () => { fireEvent.click(screen.getByRole('button')); });
    expect(vi.getTimerCount()).toBe(1);
    unmount();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('allows another account but prevents resubmission after switching back', async () => {
    const first = deferred<string>();
    const second = deferred<string>();
    const action = vi.fn().mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
    const { rerender } = render(<ActionButton {...props} action={action} />);
    fireEvent.click(screen.getByRole('button'));
    rerender(<ActionButton {...props} contextKey="other" action={action} />);
    expect(screen.getByRole('button')).toBeEnabled();
    fireEvent.click(screen.getByRole('button'));
    rerender(<ActionButton {...props} action={action} />);
    expect(screen.getByRole('button')).toBeDisabled();
    fireEvent.click(screen.getByRole('button'));
    expect(action).toHaveBeenCalledTimes(2);
    await act(async () => first.resolve('旧账号结果'));
    expect(screen.getByRole('button')).toBeEnabled();
    expect(screen.getByRole('status')).toBeEmptyDOMElement();
    await act(async () => second.resolve('其他账号结果'));
    expect(screen.getByRole('button')).toHaveAttribute('data-feedback', 'idle');
  });
});
