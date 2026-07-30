// Gmail-style far-left rail to switch top-level functions (Mail / Tasks). Keeps each
// function in its own clean space instead of cramming tasks into the mail view.
import { useTranslation } from 'react-i18next';

const ITEMS = [
  {
    key: 'mail',
    labelKey: 'rail.mail', label: 'Mail',
    icon: (
      <>
        <polyline points="22 12 16 12 14 15 10 15 8 12 2 12"/>
        <path d="M5.45 5.11L2 12v6a2 2 0 002 2h16a2 2 0 002-2v-6l-3.45-6.89A2 2 0 0016.76 4H7.24a2 2 0 00-1.79 1.11z"/>
      </>
    ),
  },
  {
    key: 'tasks',
    labelKey: 'rail.tasks', label: 'Tasks',
    icon: (
      <>
        <path d="M9 11l3 3L22 4"/>
        <path d="M21 12v7a2 2 0 01-2 2H5a2 2 0 01-2-2V5a2 2 0 012-2h11"/>
      </>
    ),
  },
  {
    key: 'clients',
    labelKey: 'rail.clients', label: 'Clients',
    icon: (
      <>
        <path d="M17 21v-2a4 4 0 00-4-4H5a4 4 0 00-4 4v2"/>
        <circle cx="9" cy="7" r="4"/>
        <path d="M23 21v-2a4 4 0 00-3-3.87"/>
        <path d="M16 3.13a4 4 0 010 7.75"/>
      </>
    ),
  },
];

export default function FunctionRail({ view, onChange, isMobile }) {
  const { t } = useTranslation();
  const w = isMobile ? 50 : 58;
  return (
    <div style={{
      width: w, flexShrink: 0, height: '100%',
      background: 'var(--bg-secondary)', borderRight: '1px solid var(--border-subtle)',
      display: 'flex', flexDirection: 'column', alignItems: 'center',
      paddingTop: 12, gap: 6, zIndex: 20,
    }}>
      {ITEMS.map(item => {
        const active = view === item.key;
        return (
          <button
            key={item.key}
            onClick={() => onChange(item.key)}
            title={t(item.labelKey, { defaultValue: item.label })}
            aria-label={t(item.labelKey, { defaultValue: item.label })}
            style={{
              display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 3,
              width: w - 12, padding: '8px 0', borderRadius: 12, cursor: 'pointer',
              border: 'none', background: active ? 'var(--accent-dim)' : 'transparent',
              color: active ? 'var(--accent)' : 'var(--text-tertiary)',
              transition: 'background 0.15s, color 0.15s',
            }}
            onMouseEnter={e => { if (!active) e.currentTarget.style.background = 'var(--bg-hover)'; }}
            onMouseLeave={e => { if (!active) e.currentTarget.style.background = 'transparent'; }}
          >
            <svg width="21" height="21" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
              {item.icon}
            </svg>
            <span style={{ fontSize: 10, fontWeight: 500 }}>
              {t(item.labelKey, { defaultValue: item.label })}
            </span>
          </button>
        );
      })}
    </div>
  );
}
