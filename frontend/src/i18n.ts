import i18n from "i18next";
import { initReactI18next } from "react-i18next";
import LanguageDetector from "i18next-browser-languagedetector";
import enUSTranslation from "./locales/en-US.json";
import zhCNTranslation from "./locales/zh-CN.json";

export function normalizeLanguage(language: string): 'zh-CN' | 'en-US' {
  return /^zh(?:-|$)/i.test(language) ? 'zh-CN' : 'en-US';
}

const resources = {
  "en-US": {
    translation: enUSTranslation,
  },
  "zh-CN": {
    translation: zhCNTranslation,
  },
};

i18n
  .use(LanguageDetector)
  .use(initReactI18next)
  .init({
    resources,
    supportedLngs: ['zh-CN', 'en-US'],
    fallbackLng: "en-US",
    detection: {
      convertDetectedLanguage: normalizeLanguage,
    },
    interpolation: {
      escapeValue: false,
    },
  });

function updateDocumentLanguage(language: string) {
  document.documentElement.lang = normalizeLanguage(language);
}

i18n.on('languageChanged', updateDocumentLanguage);
updateDocumentLanguage(i18n.resolvedLanguage ?? i18n.language ?? 'en-US');

export default i18n;
