import { afterEach, describe, expect, it } from 'vitest';
import i18n from '../../src/i18n';
import { getErrorMessage } from '../../src/utils/error';

afterEach(async () => { await i18n.changeLanguage('en-US'); });

describe('localized error messages', () => {
  it('translates the network error from the screenshot and preserves its code', async () => {
    const error = new Error('Request failed with error code 7: Could not connect to server');
    await i18n.changeLanguage('zh-CN');
    expect(getErrorMessage(error, '失败'))
      .toBe('无法连接到服务器，请稍后重试。（错误码：7）');
    await i18n.changeLanguage('en-US');
    expect(getErrorMessage(error, 'Failed')).toContain('Error code: 7');
  });

  it('localizes raw backend JSON and stored task errors at display time', async () => {
    await i18n.changeLanguage('zh-CN');
    expect(getErrorMessage(new Error('{"error":"Download not found"}'), '失败'))
      .toBe('未找到下载任务');
    expect(getErrorMessage('Chunk 2: HTTP 503', '失败')).toBe('下载分片 2 失败（HTTP 503）。');
    expect(getErrorMessage('License required - purchase the app first', '失败'))
      .toBe('需要许可证 - 请先购买该应用');
    expect(getErrorMessage('Apple version history request failed: HTTP 500', '失败'))
      .toContain('HTTP 500');
    await i18n.changeLanguage('en-US');
    expect(getErrorMessage('Download not found', 'Failed')).toBe('Download not found');
  });

  it('handles DNS, TLS, timeout, and unknown transport codes', async () => {
    await i18n.changeLanguage('zh-CN');
    for (const [code, expected] of [['6', '解析'], ['28', '超时'], ['35', '安全连接'], ['99', '网络请求失败']]) {
      expect(getErrorMessage(`Request failed with error code ${code}: transport error`, '失败'))
        .toContain(expected);
    }
  });

  it('uses fallbacks for empty errors and retains unfamiliar Apple explanations', async () => {
    await i18n.changeLanguage('zh-CN');
    expect(getErrorMessage(undefined, '操作失败')).toBe('操作失败');
    expect(getErrorMessage(new Error(''), '操作失败')).toBe('操作失败');
    expect(getErrorMessage(new Error('Apple 提示需先验证付款信息'), '操作失败'))
      .toBe('Apple 提示需先验证付款信息');
    expect(getErrorMessage(new Error('New Apple explanation'), '操作失败')).toBe('New Apple explanation');
  });
});
