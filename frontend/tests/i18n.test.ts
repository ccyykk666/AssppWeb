import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { afterEach, describe, expect, it } from 'vitest';
import i18n, { normalizeLanguage } from '../src/i18n';
import english from '../src/locales/en-US.json';
import chinese from '../src/locales/zh-CN.json';

function flatten(value: Record<string, unknown>, prefix = ''): Record<string, string> {
  return Object.fromEntries(Object.entries(value).flatMap(([key, child]) => {
    const path = prefix ? `${prefix}.${key}` : key;
    return typeof child === 'string' ? [[path, child]]
      : Object.entries(flatten(child as Record<string, unknown>, path));
  }));
}

function sourceFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    return entry.isDirectory() ? sourceFiles(path)
      : /\.tsx?$/.test(entry.name) ? [path] : [];
  });
}

afterEach(async () => { await i18n.changeLanguage('en-US'); });

describe('supported languages and translation coverage', () => {
  it('keeps familiar technical labels concise in both languages', async () => {
    for (const language of ['zh-CN', 'en-US']) {
      await i18n.changeLanguage(language);
      expect(i18n.t('search.versions.buildId', { id: '891942197' })).toBe('ID: 891942197');
      for (const key of ['search.product.bundleId', 'downloads.add.bundleId', 'downloads.package.bundleId']) {
        expect(i18n.t(key)).toBe('Bundle ID');
      }
      expect(i18n.t('accounts.detail.dsid')).toBe('DSID');
      expect(i18n.t('accounts.detail.pod')).toBe('Pod');
    }
  });

  it('normalizes previous languages and regional browser preferences', () => {
    expect(['zh', 'zh-TW', 'zh-HK', 'zh-CN'].map(normalizeLanguage))
      .toEqual(['zh-CN', 'zh-CN', 'zh-CN', 'zh-CN']);
    expect(['en-GB', 'en-US', 'ja', 'ko', 'ru'].map(normalizeLanguage))
      .toEqual(['en-US', 'en-US', 'en-US', 'en-US', 'en-US']);
    expect(Object.keys(i18n.options.resources ?? {}).sort()).toEqual(['en-US', 'zh-CN']);
  });

  it('keeps translation keys and interpolation parameters aligned', () => {
    const en = flatten(english);
    const zh = flatten(chinese);
    expect(Object.keys(zh).sort()).toEqual(Object.keys(en).sort());
    for (const key of Object.keys(en)) {
      expect(zh[key].match(/{{[^}]+}}/g) ?? [], key)
        .toEqual(en[key].match(/{{[^}]+}}/g) ?? []);
    }
  });

  it('covers every literal translation key used by the frontend', () => {
    const translations = flatten(english);
    const missing = new Set<string>();
    const root = join(dirname(fileURLToPath(import.meta.url)), '../src');
    for (const path of sourceFiles(root)) {
      const source = ts.createSourceFile(path, readFileSync(path, 'utf8'), ts.ScriptTarget.Latest, true);
      function visit(node: ts.Node) {
        if (ts.isCallExpression(node) &&
          (node.expression.getText(source) === 't' || node.expression.getText(source) === 'i18n.t') &&
          node.arguments[0] && ts.isStringLiteral(node.arguments[0])) {
          const key = node.arguments[0].text;
          if (!(key in translations)) missing.add(key);
        }
        ts.forEachChild(node, visit);
      }
      visit(source);
    }
    expect([...missing].sort()).toEqual([]);
  });

  it('updates the document language when switching between Chinese and English', async () => {
    await i18n.changeLanguage('zh-CN');
    expect(document.documentElement.lang).toBe('zh-CN');
    await i18n.changeLanguage('en-US');
    expect(document.documentElement.lang).toBe('en-US');
  });
});
