import { useEffect, useState } from 'react';
import { useLocation, useParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import PageContainer from '../Layout/PageContainer';
import Alert from '../common/Alert';
import AppIcon from '../common/AppIcon';
import Spinner from '../common/Spinner';
import { getReleaseHistory } from '../../api/search';
import { getErrorMessage } from '../../utils/error';
import type { ReleaseHistoryResult, Software } from '../../types';

export default function ReleaseNotesHistory() {
  const { appId } = useParams<{ appId: string }>();
  const location = useLocation();
  const { t, i18n } = useTranslation();
  const navigationState = location.state as {
    app?: Software;
    country?: string;
  } | null;
  const app = navigationState?.app;
  const country = navigationState?.country ?? 'US';
  const [history, setHistory] = useState<ReleaseHistoryResult | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [requestKey, setRequestKey] = useState(0);

  useEffect(() => {
    const numericId = Number(appId);
    if (!Number.isSafeInteger(numericId) || numericId <= 0) {
      setError(t('search.releaseHistory.invalidApp'));
      setLoading(false);
      return;
    }

    let cancelled = false;
    setLoading(true);
    setError('');
    getReleaseHistory(numericId, country, i18n.resolvedLanguage ?? i18n.language)
      .then((result) => {
        if (!cancelled) setHistory(result);
      })
      .catch((reason) => {
        if (!cancelled) {
          setError(getErrorMessage(reason, t('search.releaseHistory.loadFailed')));
        }
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [appId, country, i18n.language, i18n.resolvedLanguage, requestKey, t]);

  const appName = app?.name || history?.appName;

  return (
    <PageContainer title={t('search.releaseHistory.title')}>
      <div className="space-y-6">
        {app && (
          <div className="flex items-center gap-4">
            <AppIcon url={app.artworkUrl} name={app.name} size="md" />
            <div>
              <h2 className="font-medium text-gray-900 dark:text-white">
                {app.name}
              </h2>
              <p className="text-sm text-gray-500 dark:text-gray-400">
                {app.bundleID}
              </p>
            </div>
          </div>
        )}

        {!app && appName && (
          <h2 className="font-medium text-gray-900 dark:text-white">
            {appName}
          </h2>
        )}

        {loading && (
          <div className="flex items-center justify-center gap-2 py-12 text-sm text-gray-500 dark:text-gray-400">
            <Spinner />
            {t('search.releaseHistory.loading')}
          </div>
        )}

        {!loading && error && (
          <div className="space-y-3">
            <Alert type="error">{error}</Alert>
            <button
              onClick={() => setRequestKey((value) => value + 1)}
              className="px-4 py-2 bg-blue-600 text-white text-sm font-medium rounded-md hover:bg-blue-700 transition-colors"
            >
              {t('search.releaseHistory.retry')}
            </button>
          </div>
        )}

        {!loading && !error && history?.entries.length === 0 && (
          <p className="text-sm text-gray-500 dark:text-gray-400">
            {t('search.releaseHistory.empty')}
          </p>
        )}

        {!loading && !error && history && history.entries.length > 0 && (
          <div className="bg-white dark:bg-gray-900 rounded-lg border border-gray-200 dark:border-gray-800 divide-y divide-gray-200 dark:divide-gray-800">
            {history.entries.map((entry, index) => (
              <article key={`${entry.version}:${entry.releaseDate}:${index}`} className="p-4">
                <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1 mb-2">
                  <h3 className="font-semibold text-gray-900 dark:text-white">
                    {t('search.releaseHistory.version', { version: entry.version })}
                  </h3>
                  {entry.releaseDate && (
                    <time
                      dateTime={entry.releaseDate}
                      className="text-xs text-gray-500 dark:text-gray-400"
                    >
                      {new Date(entry.releaseDate).toLocaleDateString(i18n.resolvedLanguage)}
                    </time>
                  )}
                </div>
                <p className="text-sm text-gray-700 dark:text-gray-300 whitespace-pre-line">
                  {entry.releaseNotes || t('search.releaseHistory.notesUnavailable')}
                </p>
              </article>
            ))}
          </div>
        )}
      </div>
    </PageContainer>
  );
}
