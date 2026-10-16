import { useEffect, useMemo, useState } from 'react';
import { Topbar } from '../layout/Topbar';
import { getMeasurements, getTemperatureScenarioStatus, setTemperatureScenarioActive } from '../api';
import { formatTs, formatNumber } from '../utils/format';
import { useAutoRefresh } from '../hooks/useAutoRefresh';

// Отображение страницы последних измерений.
export function Measurements() {
  const [rows, setRows] = useState([]);
  const [query, setQuery] = useState('');
  const [tempScenarioActive, setTempScenarioActive] = useState(true);
  const [tempScenarioBusy, setTempScenarioBusy] = useState(false);

  // Загрузка последних измерений.
  const load = async () => {
    try {
      const data = await getMeasurements();
      setRows(data || []);
    } catch (e) {
      console.error('measurements load error', e);
      setRows([]);
    }
  };

  useEffect(() => {
    load();
  }, []);

  useAutoRefresh(load, 2000);

  useEffect(() => {
    let mounted = true;
    getTemperatureScenarioStatus()
      .then((data) => {
        if (!mounted) return;
        if (typeof data?.active === 'boolean') {
          setTempScenarioActive(data.active);
        }
      })
      .catch((e) => console.error(e));
    return () => {
      mounted = false;
    };
  }, []);

  // Переключение температурного сценария.
  const handleScenarioToggle = async () => {
    const next = !tempScenarioActive;
    try {
      setTempScenarioBusy(true);
      await setTemperatureScenarioActive({ active: next });
      setTempScenarioActive(next);
    } catch (e) {
      console.error(e);
    } finally {
      setTempScenarioBusy(false);
    }
  };

  const filteredRows = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return rows;
    return rows.filter((r) => {
      const param = (r.parameter ?? r.name ?? r.id_parameter ?? '').toString().toLowerCase();
      const zone = (r.zone ?? r.zone_name ?? r.zoneId ?? r.zone_id ?? '').toString().toLowerCase();
      return param.includes(q) || zone.includes(q);
    });
  }, [rows, query]);

  // Отображение статуса измерения относительно уставок.
  const renderStatus = (row) => {
    const min = row.ref_min;
    const max = row.ref_max;
    const val = Number(row.value);
    const out =
      (!Number.isNaN(val) && min != null && val < Number(min)) ||
      (!Number.isNaN(val) && max != null && val > Number(max));
    if (out) return <span className="chip danger">Вне диапазона</span>;
    return <span className="chip success">Норма</span>;
  };

  return (
    <div>
      <Topbar
        title="Измерения"
        subtitle="Последние 100 измерений"
        actions={
          <label className={`toggle ${tempScenarioActive ? 'on' : ''} ${tempScenarioBusy ? 'disabled' : ''}`}>
            <input
              type="checkbox"
              checked={tempScenarioActive}
              onChange={handleScenarioToggle}
              disabled={tempScenarioBusy}
              aria-label="Сценарий температуры"
            />
            <span className="track">
              <span className="thumb" />
            </span>
            <span className="toggle-label">
              Сценарий: {tempScenarioActive ? 'Вкл' : 'Выкл'}
            </span>
          </label>
        }
      />
      <div className="panel">
        <div className="filters">
          <label className="input-group">
            <div className="label">Поиск по параметру</div>
            <input
              className="input"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Введите параметр"
            />
          </label>
        </div>
        <table className="table">
          <thead>
            <tr>
              <th>ID</th>
              <th>Параметр</th>
              <th>Зона</th>
              <th>Значение</th>
              <th>Ед.</th>
              <th>Время</th>
              <th>Статус</th>
            </tr>
          </thead>
          <tbody>
            {filteredRows.map((r, index) => (
              <tr key={r.id ?? `${r.id_parameter}-${r.ts}`}>
                <td>{index + 1}</td>
                <td>{r.parameter ?? r.name ?? r.id_parameter}</td>
                <td>{r.zone ?? r.zone_name ?? (r.zone_id ? `Зона ${r.zone_id}` : '—')}</td>
                <td>{formatNumber(r.value)}</td>
                <td>{r.unit ?? ''}</td>
                <td>{r.ts ? formatTs(r.ts) : ''}</td>
                <td>{renderStatus(r)}</td>
              </tr>
            ))}
          </tbody>
        </table>
        {!filteredRows.length && <div className="muted">Нет данных</div>}
      </div>
    </div>
  );
}
