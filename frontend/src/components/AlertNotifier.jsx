import { useEffect, useMemo, useRef, useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { getErrors } from '../api';
import { formatAlertText } from '../utils/alerts';
import { formatTs, statusLabel } from '../utils/format';

const STORAGE_KEY = 'lastHandledAlertId';
const CORRECTION_STORAGE_KEY = 'lastHandledHumidityCorrectionAlertId';
const POLL_MS = 5000;
const FRESH_EVENT_MS = 2 * 60 * 1000;
const VISIBLE_ALERT_PATHS = new Set(['/', '/errors']);
const HUMIDITY_ABOVE_SETPOINT_CODE = 'WARNING_HUM_ABOVESETPOINT';
const HUMIDITY_TEMPERATURE_CORRECTION_CODE = 'WARNING_HUM_TEMPCORRECTION';

// Преобразование значения в число для сравнения идентификаторов.
const toNumber = (value) => {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
};

// Проверка принадлежности события к предупреждениям.
const isAlert = (event) => {
  const severity = (event?.severity || event?.status || '').toString().toLowerCase();
  return severity === 'warning' || severity === 'critical' || severity === 'danger';
};

// Проверка предупреждения о снижении NDVI в зоне A2.
const isNdviA2Alert = (event) => {
  const code = String(event?.code || '').toUpperCase();
  if (code === 'OUT-10') return true;
  const text = String(event?.text || '').toLowerCase();
  return text.includes('ndvi') && text.includes('a2');
};

// Проверка критического уровня события.
const isCritical = (event) => {
  const severity = (event?.severity || event?.status || '').toString().toLowerCase();
  return severity === 'critical' || severity === 'danger';
};

// Проверка события коррекции влажности через температуру.
const isHumidityTemperatureCorrection = (event) =>
  String(event?.code || '').toUpperCase() === HUMIDITY_TEMPERATURE_CORRECTION_CODE;

// Проверка события, которое должно остаться только в журнале.
const isSilentJournalAlert = (event) =>
  String(event?.code || '').toUpperCase() === HUMIDITY_ABOVE_SETPOINT_CODE;

// Проверка актуальности события по времени.
const isFreshEvent = (event) => {
  const ts = new Date(event?.ts).getTime();
  return Number.isFinite(ts) && Date.now() - ts <= FRESH_EVENT_MS;
};

// Отображение модальных предупреждений для оператора.
export function AlertNotifier() {
  const location = useLocation();
  const navigate = useNavigate();
  const [notice, setNotice] = useState(null);
  const lastHandledRef = useRef(toNumber(localStorage.getItem(STORAGE_KEY)));
  const lastCorrectionHandledRef = useRef(toNumber(localStorage.getItem(CORRECTION_STORAGE_KEY)));
  const initializedRef = useRef(false);

  const alertsVisibleOnScreen = useMemo(
    () => VISIBLE_ALERT_PATHS.has(location.pathname),
    [location.pathname],
  );

  // Сохранение идентификатора обработанного предупреждения.
  const remember = (id) => {
    if (!id || id <= lastHandledRef.current) return;
    lastHandledRef.current = id;
    localStorage.setItem(STORAGE_KEY, String(id));
  };

  // Сохранение идентификатора обработанной рекомендации по влажности.
  const rememberCorrection = (id) => {
    if (!id || id <= lastCorrectionHandledRef.current) return;
    lastCorrectionHandledRef.current = id;
    localStorage.setItem(CORRECTION_STORAGE_KEY, String(id));
  };

  useEffect(() => {
    let cancelled = false;

    // Проверка новых предупреждений из журнала ошибок.
    const check = async () => {
      try {
        const rows = await getErrors();
        if (cancelled || !Array.isArray(rows) || !rows.length) return;

        const correctionAlert = rows
          .filter((row) => isAlert(row) && isHumidityTemperatureCorrection(row))
          .filter((row) => toNumber(row.id) > lastCorrectionHandledRef.current && isFreshEvent(row))
          .sort((a, b) => toNumber(b.id) - toNumber(a.id))[0];
        if (correctionAlert) {
          setNotice(correctionAlert);
          initializedRef.current = true;
          return;
        }

        const latestAlert = rows
          .filter((row) => isAlert(row) && !isNdviA2Alert(row) && !isSilentJournalAlert(row))
          .filter((row) => !isHumidityTemperatureCorrection(row))
          .sort((a, b) => toNumber(b.id) - toNumber(a.id))[0];
        const latestId = toNumber(latestAlert?.id);
        if (!latestAlert || !latestId) return;

        if (!initializedRef.current) {
          initializedRef.current = true;
          if (
            (!alertsVisibleOnScreen || isHumidityTemperatureCorrection(latestAlert)) &&
            latestId > lastHandledRef.current &&
            isFreshEvent(latestAlert)
          ) {
            setNotice(latestAlert);
          } else {
            remember(Math.max(lastHandledRef.current, latestId));
          }
          return;
        }

        if (latestId <= lastHandledRef.current) return;

        if (alertsVisibleOnScreen && !isHumidityTemperatureCorrection(latestAlert)) {
          remember(latestId);
          setNotice(null);
          return;
        }

        setNotice(latestAlert);
      } catch (e) {
        console.error('alert notifier error', e);
      }
    };

    check();
    const timer = setInterval(check, POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [alertsVisibleOnScreen]);

  useEffect(() => {
    if (alertsVisibleOnScreen && notice && !isHumidityTemperatureCorrection(notice)) {
      const timer = setTimeout(() => {
        remember(toNumber(notice.id));
        setNotice(null);
      }, 0);
      return () => clearTimeout(timer);
    }
    return undefined;
  }, [alertsVisibleOnScreen, notice]);

  if (!notice) return null;

  const critical = isCritical(notice);
  const id = toNumber(notice.id);

  // Закрытие текущего предупреждения.
  const close = () => {
    if (isHumidityTemperatureCorrection(notice)) {
      rememberCorrection(id);
    } else {
      remember(id);
    }
    setNotice(null);
  };

  // Переход к блоку изменения уставок.
  const openReferenceEditor = () => {
    close();
    navigate('/#reference-editor');
  };

  if (isHumidityTemperatureCorrection(notice)) {
    const humidityValue = Number(notice.value);
    const valueText = Number.isFinite(humidityValue) ? `${humidityValue} %` : '75 %';

    return (
      <div className="modal-overlay operator-alert-overlay" role="presentation">
        <div className="modal-card operator-alert-card" role="alertdialog" aria-modal="true">
          <div className="modal-title">Предупреждение</div>
          <div className="operator-alert-body">
            <div className="operator-alert-detail">
              Текущая влажность: {valueText}. Допустимый диапазон: 70-80%.
            </div>
            <div className="operator-alert-recommendation">
              Рекомендация: повысить температуру, чтобы снизить влажность воздуха и вернуть микроклимат в допустимый диапазон.
            </div>
            <div className="alert-toast-time">{formatTs(notice.ts)}</div>
          </div>
          <div className="modal-actions">
            <button className="btn primary" onClick={openReferenceEditor}>
              Перейти к изменению уставок
            </button>
            <button className="btn ghost" onClick={close} aria-label="Закрыть уведомление">
              Закрыть
            </button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className={`alert-toast ${critical ? 'critical' : 'warning'}`} role="status">
      <div>
        <div className="alert-toast-title">{statusLabel(critical ? 'critical' : 'warning')}</div>
        <div className="alert-toast-text">{formatAlertText(notice)}</div>
        <div className="alert-toast-time">{formatTs(notice.ts)}</div>
      </div>
      <div className="alert-toast-actions">
        <button className="btn primary" onClick={openReferenceEditor}>
          Изменить параметры
        </button>
        <button className="btn ghost" onClick={close} aria-label="Закрыть уведомление">
          Закрыть
        </button>
      </div>
    </div>
  );
}
