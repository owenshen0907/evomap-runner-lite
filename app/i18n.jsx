'use client';

import { createContext, useContext, useEffect, useMemo, useState } from 'react';
import { api } from './client-utils.js';

const LANGS = [
  ['zh-CN', '中文'],
  ['en', 'English'],
  ['ja', '日本語'],
];

const dict = {
  'zh-CN': {
    overview: '总览', setup: '上手设置', tasks: '悬赏任务', language: '语言',
    installed: '官方包已安装', currentCredits: '当前积分', reputation: '节点声誉', publishedAssets: '已发布资产', promotedAssets: '已推广资产',
    search: '搜索', scan: '扫描悬赏', claim: '认领', copy: '复制', fullFetch: 'Full Fetch', currentLanguage: '当前语言',
  },
  en: {
    overview: 'Overview', setup: 'Setup', tasks: 'Bounties', language: 'Language',
    installed: 'Official package installed', currentCredits: 'Credits', reputation: 'Reputation', publishedAssets: 'Published', promotedAssets: 'Promoted',
    search: 'Search', scan: 'Scan bounties', claim: 'Claim', copy: 'Copy', fullFetch: 'Full Fetch', currentLanguage: 'Current language',
  },
  ja: {
    overview: '概要', setup: 'セットアップ', tasks: '懸賞タスク', language: '言語',
    installed: '公式パッケージ導入済み', currentCredits: 'クレジット', reputation: '評判', publishedAssets: '公開済み', promotedAssets: '昇格済み',
    search: '検索', scan: '懸賞をスキャン', claim: '受注', copy: 'コピー', fullFetch: 'Full Fetch', currentLanguage: '現在の言語',
  },
};

const I18nContext = createContext(null);

export function I18nProvider({ children }) {
  const [lang, setLangState] = useState('zh-CN');

  useEffect(() => {
    const saved = localStorage.getItem('ef-lang');
    if (saved && dict[saved]) setLangState(saved);
  }, []);

  function setLang(next) {
    setLangState(next);
    localStorage.setItem('ef-lang', next);
  }

  const value = useMemo(() => ({
    lang,
    langs: LANGS,
    setLang,
    t: (key) => dict[lang]?.[key] || dict['zh-CN'][key] || key,
  }), [lang]);

  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>;
}

export function useI18n() {
  return useContext(I18nContext);
}

export function LanguageSelect({ compact = false }) {
  const { lang, langs, setLang, t } = useI18n();
  return (
    <label className={`language-select ${compact ? 'compact' : ''}`}>
      <span>{t('language')}</span>
      <select value={lang} onChange={(event) => setLang(event.target.value)}>
        {langs.map(([value, label]) => <option value={value} key={value}>{label}</option>)}
      </select>
    </label>
  );
}

export function useTranslatedItems(items, fields) {
  const { lang } = useI18n();
  const source = Array.isArray(items) ? items : [];
  const [translated, setTranslated] = useState(source);
  const fieldsKey = fields.join('|');
  const itemsKey = source.map((item, index) => {
    const stableId = item?.id || item?.task_id || item?.asset_id || item?.skillId || index;
    return [stableId, ...fields.map((field) => item?.[field] || '')].join('\u001f');
  }).join('\u001e');

  useEffect(() => {
    let cancelled = false;
    const fieldList = fieldsKey.split('|').filter(Boolean);
    if (!source.length) {
      setTranslated((current) => (current.length ? [] : current));
      return;
    }
    setTranslated(source);
    const texts = [];
    const refs = [];
    source.forEach((item, index) => {
      fieldList.forEach((field) => {
        const value = item?.[field];
        if (value) {
          refs.push([index, field]);
          texts.push(String(value));
        }
      });
    });
    if (!texts.length) {
      setTranslated(source);
      return;
    }
    api('/api/translate', { method: 'POST', body: JSON.stringify({ lang, texts }) })
      .then((data) => {
        if (cancelled) return;
        const next = source.map((item) => ({ ...item }));
        (data.translations || []).forEach((value, i) => {
          const [index, field] = refs[i];
          next[index][field] = value;
        });
        setTranslated(next);
      })
      .catch(() => setTranslated(source));
    return () => { cancelled = true; };
  }, [itemsKey, fieldsKey, lang]);

  return translated;
}
