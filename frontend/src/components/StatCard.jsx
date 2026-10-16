/** Отображение краткой статистической карточки. */
export function StatCard({ title, value, hint, tone = 'neutral', trend }) {
  return (
    <div className={`panel stat-card ${tone}`}>
      <div className="muted">{title}</div>
      <div className="card-row">
        <div className="stat-value">{value}</div>
        {trend && <div className={trend > 0 ? 'trend-up' : 'trend-down'}>{trend > 0 ? `+${trend}%` : `${trend}%`}</div>}
      </div>
      {hint && <div className="tiny">{hint}</div>}
    </div>
  );
}
