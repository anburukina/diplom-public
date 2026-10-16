import { formatNumber } from '../../../utils/format';

/** Отображение карточек текущих значений микроклимата. */
export function MetricCards({ values, statuses }) {
  return (
    <div className="grid cols-3">
      <div className={`panel stat-card ${statuses.temperature || ''}`}>
        <div className="muted">Температура</div>
        <div className="stat-value">{formatNumber(values.temperature)} °C</div>
      </div>
      <div className={`panel stat-card ${statuses.humidity || ''}`}>
        <div className="muted">Влажность</div>
        <div className="stat-value">{formatNumber(values.humidity)} %</div>
      </div>
      <div className={`panel stat-card ${statuses.co2 || ''}`}>
        <div className="muted">CO₂</div>
        <div className="stat-value">{formatNumber(values.co2)} ppm</div>
      </div>
    </div>
  );
}
