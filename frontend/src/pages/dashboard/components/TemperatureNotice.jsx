import { formatNumber } from '../../../utils/format';

/** Отображение модального уведомления о температурном сценарии. */
export function TemperatureNotice({ notice, temperatureValue, onCriticalAck, onNormalAck }) {
  if (!notice) return null;

  return (
    <div className="modal-overlay">
      <div className={`modal-card ${notice === 'critical' ? 'critical' : ''}`}>
        <div className="modal-title">
          {notice === 'critical' ? 'Температура критически низкая' : 'Температура в норме'}
        </div>
        <div className="muted">
          {notice === 'critical'
            ? `Температура опустилась до ${formatNumber(temperatureValue)} °C. Включить отопление?`
            : 'Температура вернулась в допустимый диапазон.'}
        </div>
        <div className="modal-actions">
          {notice === 'critical' ? (
            <button className="btn primary" onClick={onCriticalAck}>
              Включить отопление
            </button>
          ) : (
            <button className="btn" onClick={onNormalAck}>
              Ок
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
